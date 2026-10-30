// Phase 1 transport: public prekeys, conversations, opaque ciphertext messages.
// The server never parses key or ciphertext bytes — size caps + presence only.
// Formats are owned by packages/crypto (identified by the integer `version`).
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { q, tx, type Queryable } from "../database/db.js";
import { me, requireAuth } from "../middleware/requireAuth.js";
import { normalizeUsername } from "../services/auth.js";
import { overLimit } from "../utils/rateLimiter.js";
import { shared } from "../utils/sharedSchema.js";
import { membersOf } from "../services/groups.js";
import { deleteFullyAcked, RETENTION, sweepMessages } from "../services/retention.js";
import {
  ackRequestSchema, CIPHERTEXT_MAX_BYTES, conversationParamsSchema, createConversationRequestSchema, KEY_MAX_BYTES,
  messagePageQuerySchema, identityBatchRequestSchema, publishKeysRequestSchema, sendMessageRequestSchema, usernameParamsSchema,
} from "@e2ee/shared";

export const LIMITS = {
  keyBytes: KEY_MAX_BYTES, // any single public key / signature
  ciphertextBytes: CIPHERTEXT_MAX_BYTES, // one message envelope
  prekeyBatch: 100, // one-time prekeys per publish
  prekeyPool: 500, // max unconsumed one-time prekeys per user
  pageSize: 100, // messages per fetch
  ackBatch: 500,
  bundlePerTargetPerMin: 30, // caps one-time-prekey draining of a single victim across all callers
} as const;

type B64Key = { keyId: number; publicKey: string; version: number };
interface PublishBody {
  identityKey?: { publicKey: string; version: number };
  signedPrekey?: B64Key & { signature: string };
  oneTimePrekeys?: B64Key[];
}

const err = (reply: FastifyReply, code: number, error: string, message: string) =>
  reply.code(code).send({ error, message });

/** Thrown INSIDE tx callbacks so the transaction rolls back; mapped to HTTP outside the tx. */
class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}
/** Run a transaction and translate ApiError into a clean JSON reply (after rollback). */
async function txReply<T>(reply: FastifyReply, fn: (c: Queryable) => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await tx(fn);
  } catch (e) {
    if (e instanceof ApiError) return reply.code(e.status).send({ error: e.code, message: e.message, ...e.extra });
    throw e;
  }
}
const isUniqueViolation = (e: unknown, constraint: string) =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === "23505" &&
  ((e as { constraint?: string }).constraint ?? constraint) === constraint;

/** Decode strict base64; returns null if it doesn't round-trip (rejects junk padding). */
function bytes(s: string, max: number): Buffer | null {
  const b = Buffer.from(s, "base64");
  if (b.length === 0 || b.length > max || b.toString("base64") !== s) return null;
  return b;
}
const digest = (b: Buffer) => createHash("sha256").update(b).digest();
const UNDELIVERABLE = "undeliverable_device_changed";
const enc = (b: Buffer | null | undefined) => (b ? Buffer.from(b).toString("base64") : null);

async function isMember(c: Queryable, conversationId: string, userId: string): Promise<boolean> {
  const r = await c.query(`SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`, [conversationId, userId]);
  return (r.rowCount ?? 0) > 0;
}

interface MsgRow { system_event?: unknown; id: string; conversation_id: string; sender_id: string; seq: string; client_msg_id: string; ciphertext: Buffer; version: number; created_at: Date }
const msgDto = (m: MsgRow) => ({
  id: m.id, conversationId: m.conversation_id, senderId: m.sender_id, seq: String(m.seq),
  clientMsgId: m.client_msg_id, ciphertext: enc(m.ciphertext), version: m.version,
  createdAt: new Date(m.created_at).toISOString(),
  ...(m.system_event ? { kind: "system" as const, event: m.system_event, senderId: "" , ciphertext: "" } : {}),
});

export async function transportRoutes(app: FastifyInstance): Promise<void> {
  // onRequest (not preHandler) so unauthenticated callers get 401 before body validation.
  app.addHook("onRequest", requireAuth);

  const maybeSweep = async () => {
    if (Math.random() >= RETENTION.probability) return;
    try { await sweepMessages(); } catch (e) { app.log.error({ err: { name: (e as Error)?.name } }, "message sweep failed"); }
  };

  // ---------- keys ----------
  app.post<{ Body: PublishBody }>("/keys/publish", {
    bodyLimit: 256 * 1024,
    ...shared({ body: publishKeysRequestSchema }),
  }, async (req, reply) => {
    const uid = me(req).id;
    const { identityKey, signedPrekey, oneTimePrekeys } = req.body;
    const ik = identityKey && bytes(identityKey.publicKey, LIMITS.keyBytes);
    const spk = signedPrekey && bytes(signedPrekey.publicKey, LIMITS.keyBytes);
    const sig = signedPrekey && bytes(signedPrekey.signature, LIMITS.keyBytes);
    if ((identityKey && !ik) || (signedPrekey && (!spk || !sig))) return err(reply, 400, "invalid_key", "Key material must be canonical base64 within size limits.");
    const otks = (oneTimePrekeys ?? []).map((k) => ({ ...k, b: bytes(k.publicKey, LIMITS.keyBytes) }));
    if (otks.some((k) => !k.b)) return err(reply, 400, "invalid_key", "Key material must be canonical base64 within size limits.");
    if (new Set(otks.map((k) => k.keyId)).size !== otks.length) return err(reply, 400, "duplicate_key_id", "Duplicate one-time prekey keyId in batch.");

    return txReply(reply, async (c) => {
      const cur = await c.query<{ identity_key: Buffer }>(`SELECT identity_key FROM identity_keys WHERE user_id = $1 FOR UPDATE`, [uid]);
      const exists = (cur.rowCount ?? 0) > 0;
      const oldIk = cur.rows[0]?.identity_key;
      if (!exists && (!ik || !spk)) throw new ApiError(400, "identity_required", "First publish must include identityKey and signedPrekey.");
      if (ik && spk && sig && identityKey && signedPrekey) {
        await c.query(
          `INSERT INTO identity_keys (user_id, identity_key, identity_key_version, signed_prekey_id, signed_prekey, signed_prekey_signature, signed_prekey_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (user_id) DO UPDATE SET identity_key = EXCLUDED.identity_key, identity_key_version = EXCLUDED.identity_key_version,
             signed_prekey_id = EXCLUDED.signed_prekey_id, signed_prekey = EXCLUDED.signed_prekey,
             signed_prekey_signature = EXCLUDED.signed_prekey_signature, signed_prekey_version = EXCLUDED.signed_prekey_version, updated_at = now()`,
          [uid, ik, identityKey.version, signedPrekey.keyId, spk, sig, signedPrekey.version]);
        // A new identity key invalidates every outstanding one-time prekey.
        if (exists) await c.query(`DELETE FROM one_time_prekeys WHERE user_id = $1 AND consumed_at IS NULL`, [uid]);
        // Identity CHANGED (new device): my unacked incoming messages encrypted to the old identity are
        // undecryptable. Flag them (hidden from me) so each sender can list + re-encrypt + resend in place.
        if (oldIk && !Buffer.from(oldIk).equals(ik)) await c.query(
          `UPDATE message_deliveries SET undeliverable_reason = $3
            WHERE recipient_id = $1 AND delivered_at IS NULL
              AND (recipient_identity_digest IS NULL OR recipient_identity_digest <> $2)
              AND message_id NOT IN (SELECT id FROM messages WHERE system_event IS NOT NULL)
              -- Only 1:1 (Olm) ciphertext depends on my identity; group (Megolm) messages stay deliverable.
              AND message_id IN (SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.kind = 'direct')`, [uid, digest(ik), UNDELIVERABLE]);
        // Pending Olm to-device envelopes (room keys) for the old identity can never be decrypted: drop them;
        // senders re-share after accepting the new identity.
        if (oldIk && !Buffer.from(oldIk).equals(ik)) await c.query(`DELETE FROM to_device_messages WHERE recipient_id = $1`, [uid]);
      } else if (ik || spk) {
        if (ik && identityKey) throw new ApiError(400, "signed_prekey_required", "Replacing identityKey requires a new signedPrekey.");
        if (spk && sig && signedPrekey) await c.query(
          `UPDATE identity_keys SET signed_prekey_id = $2, signed_prekey = $3, signed_prekey_signature = $4, signed_prekey_version = $5, updated_at = now() WHERE user_id = $1`,
          [uid, signedPrekey.keyId, spk, sig, signedPrekey.version]);
      }
      if (otks.length) {
        const n = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM one_time_prekeys WHERE user_id = $1 AND consumed_at IS NULL`, [uid]);
        if ((n.rows[0]?.n ?? 0) + otks.length > LIMITS.prekeyPool) throw new ApiError(409, "prekey_pool_full", `At most ${LIMITS.prekeyPool} unused one-time prekeys.`);
        const r = await c.query(
          `INSERT INTO one_time_prekeys (id, user_id, key_id, public_key, version)
           SELECT gen_random_uuid(), $1, k, p, v FROM unnest($2::int[], $3::bytea[], $4::int[]) AS t(k, p, v)
           ON CONFLICT (user_id, key_id) WHERE consumed_at IS NULL DO NOTHING`,
          [uid, otks.map((k) => k.keyId), otks.map((k) => k.b), otks.map((k) => k.version)]);
        if ((r.rowCount ?? 0) !== otks.length) throw new ApiError(409, "prekey_id_conflict", "One-time prekey keyId already in the unused pool.");
      }
      const left = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM one_time_prekeys WHERE user_id = $1 AND consumed_at IS NULL`, [uid]);
      return { oneTimePrekeyCount: left.rows[0]?.n ?? 0 };
    });
  });

  app.get("/keys/count", async (req) => {
    const r = await q().query<{ n: number }>(`SELECT count(*)::int AS n FROM one_time_prekeys WHERE user_id = $1 AND consumed_at IS NULL`, [me(req).id]);
    return { oneTimePrekeyCount: r.rows[0]?.n ?? 0 };
  });

  app.get<{ Params: { username: string } }>("/keys/bundle/:username", {
    ...shared({ params: usernameParamsSchema }),
    config: { rateLimit: { hook: "preHandler", skipOnError: true, max: 60, timeWindow: "1 minute", keyGenerator: (r) => `bundle:${r.user?.id ?? r.ip}` } },
  }, async (req, reply) => {
    const target = normalizeUsername(req.params.username);
    // E2EE-75: shared store; fails OPEN (logged) so a limiter hiccup never blocks messaging.
    const wait = await overLimit(`bundle-target:${target}`, LIMITS.bundlePerTargetPerMin, 60_000)
      .catch((e: Error) => { req.log.error({ err: { name: e.name } }, "rate limiter unavailable (fail-open)"); return 0; });
    if (wait) return reply.code(429).header("retry-after", String(wait))
      .send({ error: "rate_limited", message: "Too many key bundle requests for this user. Try again later." });
    return txReply(reply, async (c) => {
      const ik = await c.query<{ user_id: string; username: string; identity_key: Buffer; identity_key_version: number; signed_prekey_id: number; signed_prekey: Buffer; signed_prekey_signature: Buffer; signed_prekey_version: number }>(
        `SELECT k.*, u.username FROM identity_keys k JOIN users u ON u.id = k.user_id WHERE u.username = $1`, [normalizeUsername(req.params.username)]);
      const k = ik.rows[0];
      if (!k) throw new ApiError(404, "not_found", "No keys published for that user.");
      // Atomic single-use hand-out; SKIP LOCKED so concurrent fetchers never get the same key.
      const otk = await c.query<{ key_id: number; public_key: Buffer; version: number }>(
        `UPDATE one_time_prekeys SET consumed_at = now() WHERE id = (
           SELECT id FROM one_time_prekeys WHERE user_id = $1 AND consumed_at IS NULL ORDER BY created_at, key_id LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING key_id, public_key, version`, [k.user_id]);
      const o = otk.rows[0];
      return ({
        userId: k.user_id, username: k.username,
        identityKey: { publicKey: enc(k.identity_key), version: k.identity_key_version },
        signedPrekey: { keyId: k.signed_prekey_id, publicKey: enc(k.signed_prekey), signature: enc(k.signed_prekey_signature), version: k.signed_prekey_version },
        oneTimePrekey: o ? { keyId: o.key_id, publicKey: enc(o.public_key), version: o.version } : null,
      });
    });
  });

  // Read-only lookup: identity + signed prekey only. Consumes NOTHING, so clients may call it
  // on every receive; per-caller limit only (no per-target drain limit — there is nothing to drain).
  app.get<{ Params: { username: string } }>("/keys/identity/:username", {
    ...shared({ params: usernameParamsSchema }),
    config: { rateLimit: { hook: "preHandler", skipOnError: true, max: 300, timeWindow: "1 minute", keyGenerator: (r) => `identity:${r.user?.id ?? r.ip}` } },
  }, async (req, reply) => {
    const r = await q().query<{ user_id: string; username: string; identity_key: Buffer; identity_key_version: number; signed_prekey_id: number; signed_prekey: Buffer; signed_prekey_signature: Buffer; signed_prekey_version: number }>(
      `SELECT k.*, u.username FROM identity_keys k JOIN users u ON u.id = k.user_id WHERE u.username = $1`, [normalizeUsername(req.params.username)]);
    const k = r.rows[0];
    if (!k) return err(reply, 404, "not_found", "No keys published for that user.");
    return {
      userId: k.user_id, username: k.username,
      identityKey: { publicKey: enc(k.identity_key), version: k.identity_key_version },
      signedPrekey: { keyId: k.signed_prekey_id, publicKey: enc(k.signed_prekey), signature: enc(k.signed_prekey_signature), version: k.signed_prekey_version },
    };
  });

  // Batch of the read-only identity lookup above: same visibility rules, one query.
  app.post<{ Body: { usernames: string[] } }>("/keys/identity/batch", {
    ...shared({ body: identityBatchRequestSchema }),
    config: { rateLimit: { hook: "preHandler", skipOnError: true, max: 120, timeWindow: "1 minute", keyGenerator: (r) => `identity-batch:${r.user?.id ?? r.ip}` } },
  }, async (req) => {
    const names = [...new Set(req.body.usernames.map(normalizeUsername))];
    const r = await q().query<{ user_id: string; username: string; identity_key: Buffer; identity_key_version: number; signed_prekey_id: number; signed_prekey: Buffer; signed_prekey_signature: Buffer; signed_prekey_version: number }>(
      `SELECT k.*, u.username FROM identity_keys k JOIN users u ON u.id = k.user_id WHERE u.username = ANY($1::text[]) ORDER BY u.username`, [names]);
    const found = new Set(r.rows.map((k) => k.username));
    return {
      identities: r.rows.map((k) => ({
        userId: k.user_id, username: k.username,
        identityKey: { publicKey: enc(k.identity_key), version: k.identity_key_version },
        signedPrekey: { keyId: k.signed_prekey_id, publicKey: enc(k.signed_prekey), signature: enc(k.signed_prekey_signature), version: k.signed_prekey_version },
      })),
      missing: names.filter((n) => !found.has(n)),
    };
  });

  // ---------- conversations ----------
  app.post<{ Body: { username: string } }>("/conversations", {
    ...shared({ body: createConversationRequestSchema }),
  }, async (req, reply) => {
    const self = me(req);
    const peer = await q().query<{ id: string; username: string }>(`SELECT id, username FROM users WHERE username = $1`, [normalizeUsername(req.body.username)]);
    const p = peer.rows[0];
    if (!p) return err(reply, 404, "not_found", "User not found.");
    if (p.id === self.id) return err(reply, 400, "self_conversation", "Cannot start a conversation with yourself.");
    const directKey = [self.id, p.id].sort().join(":");
    return tx(async (c) => {
      const ins = await c.query<{ id: string }>(
        `INSERT INTO conversations (id, kind, direct_key) VALUES (gen_random_uuid(), 'direct', $1) ON CONFLICT (direct_key) DO NOTHING RETURNING id`, [directKey]);
      let id = ins.rows[0]?.id;
      const created = !!id;
      if (id) {
        await c.query(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2),($1,$3)`, [id, self.id, p.id]);
      } else {
        id = (await c.query<{ id: string }>(`SELECT id FROM conversations WHERE direct_key = $1`, [directKey])).rows[0]?.id;
      }
      return reply.code(created ? 201 : 200).send({
        conversation: { id, kind: "direct", members: [{ id: self.id, username: self.username }, { id: p.id, username: p.username }] },
      });
    });
  });

  app.get("/conversations", async (req) => {
    const r = await q().query<{ id: string; kind: string; last_seq: string; created_at: Date; admin_id: string | null; membership_version: number; encrypted_meta: Buffer | null; members: { id: string; username: string }[] }>(
      `SELECT c.id, c.kind, c.last_seq, c.created_at, c.admin_id, c.membership_version, c.encrypted_meta,
              json_agg(json_build_object('id', u.id, 'username', u.username, 'joinedAt', to_char(m.joined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY u.username) AS members
         FROM conversation_members mine
         JOIN conversations c ON c.id = mine.conversation_id
         JOIN conversation_members m ON m.conversation_id = c.id
         JOIN users u ON u.id = m.user_id
        WHERE mine.user_id = $1
        GROUP BY c.id, c.kind, c.last_seq, c.created_at, c.admin_id, c.membership_version, c.encrypted_meta ORDER BY c.created_at DESC LIMIT 200`, [me(req).id]);
    return { conversations: r.rows.map((c) => ({
      id: c.id, kind: c.kind, lastSeq: String(c.last_seq), createdAt: new Date(c.created_at).toISOString(), members: c.members,
      ...(c.kind === "group" ? { adminId: c.admin_id, membershipVersion: c.membership_version, encryptedMeta: enc(c.encrypted_meta) } : {}),
    })) };
  });

  // ---------- messages ----------
  app.post<{ Params: { id: string }; Body: { clientMsgId: string; ciphertext: string; version: number; attachmentRefs?: string[]; membershipVersion?: number } }>("/conversations/:id/messages", {
    ...shared({ params: conversationParamsSchema, body: sendMessageRequestSchema }),
    config: { rateLimit: { hook: "preHandler", skipOnError: true, max: 120, timeWindow: "1 minute", keyGenerator: (r) => `msg:${r.user?.id ?? r.ip}` } },
  }, async (req, reply) => {
    const uid = me(req).id;
    const blob = bytes(req.body.ciphertext, LIMITS.ciphertextBytes);
    if (!blob) return err(reply, 400, "invalid_ciphertext", "Ciphertext must be canonical base64 within size limits.");
    const findDup = (c: Queryable) => c.query<MsgRow>(
      `SELECT * FROM messages WHERE conversation_id = $1 AND sender_id = $2 AND client_msg_id = $3`, [req.params.id, uid, req.body.clientMsgId]);
    try {
      return await txReply(reply, async (c) => {
      // Lock the conversation first: serializes against membership changes (groups) and seq allocation.
      const conv = (await c.query<{ kind: string; membership_version: number }>(`SELECT kind, membership_version FROM conversations WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!conv || !(await isMember(c, req.params.id, uid))) throw new ApiError(404, "not_found", "Conversation not found.");
      if (conv.kind === "group" && req.body.membershipVersion !== conv.membership_version) {
        throw new ApiError(409, "membership_changed", "Group membership changed; rotate the group session and resend.",
          { membershipVersion: conv.membership_version, members: await membersOf(c, req.params.id) });
      }
      const dup = await findDup(c);
      const d0 = dup.rows[0];
      if (d0) {
        // Resend after the recipient changed device: replace ciphertext in place (same id + seq), re-stamp, unflag.
        const fl = await c.query(
          `UPDATE message_deliveries d SET undeliverable_reason = NULL,
                  recipient_identity_digest = (SELECT sha256(k.identity_key) FROM identity_keys k WHERE k.user_id = d.recipient_id)
            WHERE d.message_id = $1 AND d.undeliverable_reason IS NOT NULL AND d.delivered_at IS NULL`, [d0.id]);
        if (!(fl.rowCount ?? 0)) return reply.code(200).send({ message: msgDto(d0), duplicate: true });
        const up = await c.query<MsgRow>(`UPDATE messages SET ciphertext = $2, version = $3 WHERE id = $1 RETURNING *`, [d0.id, blob, req.body.version]);
        return reply.code(200).send({ message: msgDto(up.rows[0] as MsgRow), duplicate: false });
      }
      // Row lock on the conversation serializes seq allocation => gap-free, monotonic.
      const s = await c.query<{ last_seq: string }>(`UPDATE conversations SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq`, [req.params.id]);
      const m = await c.query<MsgRow>(
        `INSERT INTO messages (id, conversation_id, sender_id, seq, client_msg_id, ciphertext, version)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6) RETURNING *`,
        [req.params.id, uid, s.rows[0]?.last_seq, req.body.clientMsgId, blob, req.body.version]);
      const row = m.rows[0] as MsgRow;
      const refs = req.body.attachmentRefs ?? [];
      if (refs.length) {
        // Only refs the sender completed in THIS conversation (no pinning others' blobs).
        const ok = await c.query(
          `SELECT ref FROM attachments WHERE ref = ANY($1::text[]) AND owner_user_id = $2 AND conversation_id = $3 AND status = 'stored'`,
          [refs, uid, req.params.id]);
        if ((ok.rowCount ?? 0) !== refs.length) throw new ApiError(400, "invalid_attachment_refs", "attachmentRefs must be stored attachments you uploaded to this conversation.");
        await c.query(`INSERT INTO message_attachments (message_id, ref) SELECT $1, unnest($2::text[])`, [row.id, refs]);
      }
      await c.query(
        `INSERT INTO message_deliveries (message_id, recipient_id, recipient_identity_digest)
         SELECT $1, cm.user_id, sha256(k.identity_key) FROM conversation_members cm LEFT JOIN identity_keys k ON k.user_id = cm.user_id
          WHERE cm.conversation_id = $2 AND cm.user_id <> $3`,
        [row.id, req.params.id, uid]);
      return reply.code(201).send({ message: msgDto(row), duplicate: false });
      }).finally(maybeSweep);
    } catch (e) {
      // Concurrent retry with the same clientMsgId lost the race: tx rolled back
      // (incl. seq bump); return the winner's row exactly like a sequential retry.
      if (!isUniqueViolation(e, "messages_conversation_id_sender_id_client_msg_id_key")) throw e;
      const dup = (await findDup(q())).rows[0];
      if (!dup) throw e;
      return reply.code(200).send({ message: msgDto(dup), duplicate: true });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>("/conversations/:id/messages", {
    ...shared({ params: conversationParamsSchema, querystring: messagePageQuerySchema }),
  }, async (req, reply) => {
    const uid = me(req).id;
    if (!(await isMember(q(), req.params.id, uid))) return err(reply, 404, "not_found", "Conversation not found.");
    const limit = Math.min(Math.max(Number(req.query.limit ?? LIMITS.pageSize), 1), LIMITS.pageSize);
    const r = await q().query<MsgRow & { delivered_at: Date | null }>(
      `SELECT m.* FROM messages m WHERE m.conversation_id = $1 AND m.seq > $2::bigint
         AND m.seq > (SELECT joined_seq FROM conversation_members WHERE conversation_id = $1 AND user_id = $4)
         AND (NOT EXISTS (SELECT 1 FROM message_deliveries d WHERE d.message_id = m.id AND d.recipient_id = $4 AND d.undeliverable_reason IS NOT NULL)
              OR (SELECT kind FROM conversations WHERE id = $1) = 'group')
       ORDER BY m.seq LIMIT $3`, [req.params.id, req.query.after ?? "0", limit + 1, uid]);
    const page = r.rows.slice(0, limit).map(msgDto);
    return { messages: page, nextCursor: page.length ? page[page.length - 1]?.seq : (req.query.after ?? "0"), hasMore: r.rows.length > limit };
  });

  // Own messages flagged undeliverable (recipient changed device), seq order. Members only; sender-scoped.
  app.get<{ Params: { id: string } }>("/conversations/:id/undeliverable", {
    ...shared({ params: conversationParamsSchema }),
  }, async (req, reply) => {
    const uid = me(req).id;
    if (!(await isMember(q(), req.params.id, uid))) return err(reply, 404, "not_found", "Conversation not found.");
    const r = await q().query<{ id: string; client_msg_id: string; seq: string; recipient_id: string; undeliverable_reason: string }>(
      `SELECT m.id, m.client_msg_id, m.seq, d.recipient_id, d.undeliverable_reason
         FROM messages m JOIN message_deliveries d ON d.message_id = m.id
        WHERE m.conversation_id = $1 AND m.sender_id = $2 AND d.undeliverable_reason IS NOT NULL AND d.delivered_at IS NULL
          AND (SELECT kind FROM conversations WHERE id = $1) = 'direct'
        ORDER BY m.seq LIMIT 500`, [req.params.id, uid]);
    return { undeliverable: r.rows.map((x) => ({ messageId: x.id, clientMsgId: x.client_msg_id, seq: String(x.seq), recipientId: x.recipient_id, reason: x.undeliverable_reason })) };
  });

  app.post<{ Body: { messageIds: string[] } }>("/messages/ack", {
    ...shared({ body: ackRequestSchema }),
  }, async (req) => {
    // Scoped to recipient_id = caller, so acking others' or unknown ids is a silent no-op.
    const r = await q().query(
      `UPDATE message_deliveries SET delivered_at = now() WHERE recipient_id = $1 AND message_id = ANY($2::uuid[]) AND delivered_at IS NULL
        AND (undeliverable_reason IS NULL OR message_id IN (SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.kind = 'group'))`,
      [me(req).id, req.body.messageIds]);
    // Retention: drop ciphertext as soon as every recipient has acked it.
    try { await deleteFullyAcked(req.body.messageIds); } catch (e) { app.log.error({ err: { name: (e as Error)?.name } }, "ack retention delete failed"); }
    await maybeSweep();
    return { acked: r.rowCount ?? 0 };
  });
}
