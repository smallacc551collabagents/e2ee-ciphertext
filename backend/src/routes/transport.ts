// Phase 1 transport: public prekeys, conversations, opaque ciphertext messages.
// The server never parses key or ciphertext bytes — size caps + presence only.
// Formats are owned by packages/crypto (identified by the integer `version`).
import type { FastifyInstance, FastifyReply } from "fastify";
import { q, tx, type Queryable } from "../database/db.js";
import { me, requireAuth } from "../middleware/requireAuth.js";
import { normalizeUsername, USERNAME_RE } from "../services/auth.js";

export const LIMITS = {
  keyBytes: 1024, // any single public key / signature
  ciphertextBytes: 32 * 1024, // one message envelope
  prekeyBatch: 100, // one-time prekeys per publish
  prekeyPool: 500, // max unconsumed one-time prekeys per user
  pageSize: 100, // messages per fetch
  ackBatch: 500,
} as const;

const b64max = (bytes: number) => Math.ceil(bytes / 3) * 4;
const B64 = "^[A-Za-z0-9+/]+={0,2}$";
const b64 = (bytes: number) => ({ type: "string", minLength: 4, maxLength: b64max(bytes), pattern: B64 }) as const;
const version = { type: "integer", minimum: 1, maximum: 65535 } as const;
const keyId = { type: "integer", minimum: 0, maximum: 2147483647 } as const;
const uuid = { type: "string", pattern: "^[0-9a-fA-F-]{36}$" } as const;
const key = b64(LIMITS.keyBytes);

type B64Key = { keyId: number; publicKey: string; version: number };
interface PublishBody {
  identityKey?: { publicKey: string; version: number };
  signedPrekey?: B64Key & { signature: string };
  oneTimePrekeys?: B64Key[];
}

const err = (reply: FastifyReply, code: number, error: string, message: string) =>
  reply.code(code).send({ error, message });

/** Decode strict base64; returns null if it doesn't round-trip (rejects junk padding). */
function bytes(s: string, max: number): Buffer | null {
  const b = Buffer.from(s, "base64");
  if (b.length === 0 || b.length > max || b.toString("base64") !== s) return null;
  return b;
}
const enc = (b: Buffer | null | undefined) => (b ? Buffer.from(b).toString("base64") : null);

async function isMember(c: Queryable, conversationId: string, userId: string): Promise<boolean> {
  const r = await c.query(`SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`, [conversationId, userId]);
  return (r.rowCount ?? 0) > 0;
}

interface MsgRow { id: string; conversation_id: string; sender_id: string; seq: string; client_msg_id: string; ciphertext: Buffer; version: number; created_at: Date }
const msgDto = (m: MsgRow) => ({
  id: m.id, conversationId: m.conversation_id, senderId: m.sender_id, seq: String(m.seq),
  clientMsgId: m.client_msg_id, ciphertext: enc(m.ciphertext), version: m.version,
  createdAt: new Date(m.created_at).toISOString(),
});

export async function transportRoutes(app: FastifyInstance): Promise<void> {
  // onRequest (not preHandler) so unauthenticated callers get 401 before body validation.
  app.addHook("onRequest", requireAuth);

  // ---------- keys ----------
  app.post<{ Body: PublishBody }>("/keys/publish", {
    bodyLimit: 256 * 1024,
    schema: { body: {
      type: "object", additionalProperties: false, minProperties: 1,
      properties: {
        identityKey: { type: "object", additionalProperties: false, required: ["publicKey", "version"], properties: { publicKey: key, version } },
        signedPrekey: { type: "object", additionalProperties: false, required: ["keyId", "publicKey", "signature", "version"],
          properties: { keyId, publicKey: key, signature: key, version } },
        oneTimePrekeys: { type: "array", minItems: 1, maxItems: LIMITS.prekeyBatch,
          items: { type: "object", additionalProperties: false, required: ["keyId", "publicKey", "version"], properties: { keyId, publicKey: key, version } } },
      },
    } },
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

    return tx(async (c) => {
      const cur = await c.query(`SELECT 1 FROM identity_keys WHERE user_id = $1 FOR UPDATE`, [uid]);
      const exists = (cur.rowCount ?? 0) > 0;
      if (!exists && (!ik || !spk)) return err(reply, 400, "identity_required", "First publish must include identityKey and signedPrekey.");
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
      } else if (ik || spk) {
        if (ik && identityKey) return err(reply, 400, "signed_prekey_required", "Replacing identityKey requires a new signedPrekey.");
        if (spk && sig && signedPrekey) await c.query(
          `UPDATE identity_keys SET signed_prekey_id = $2, signed_prekey = $3, signed_prekey_signature = $4, signed_prekey_version = $5, updated_at = now() WHERE user_id = $1`,
          [uid, signedPrekey.keyId, spk, sig, signedPrekey.version]);
      }
      if (otks.length) {
        const n = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM one_time_prekeys WHERE user_id = $1 AND consumed_at IS NULL`, [uid]);
        if ((n.rows[0]?.n ?? 0) + otks.length > LIMITS.prekeyPool) return err(reply, 409, "prekey_pool_full", `At most ${LIMITS.prekeyPool} unused one-time prekeys.`);
        const r = await c.query(
          `INSERT INTO one_time_prekeys (id, user_id, key_id, public_key, version)
           SELECT gen_random_uuid(), $1, k, p, v FROM unnest($2::int[], $3::bytea[], $4::int[]) AS t(k, p, v)
           ON CONFLICT (user_id, key_id) DO NOTHING`,
          [uid, otks.map((k) => k.keyId), otks.map((k) => k.b), otks.map((k) => k.version)]);
        if ((r.rowCount ?? 0) !== otks.length) throw Object.assign(new Error("One-time prekey keyId already used."), { statusCode: 409 });
      }
      const left = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM one_time_prekeys WHERE user_id = $1 AND consumed_at IS NULL`, [uid]);
      return reply.send({ oneTimePrekeyCount: left.rows[0]?.n ?? 0 });
    });
  });

  app.get("/keys/count", async (req) => {
    const r = await q().query<{ n: number }>(`SELECT count(*)::int AS n FROM one_time_prekeys WHERE user_id = $1 AND consumed_at IS NULL`, [me(req).id]);
    return { oneTimePrekeyCount: r.rows[0]?.n ?? 0 };
  });

  app.get<{ Params: { username: string } }>("/keys/bundle/:username", {
    schema: { params: { type: "object", required: ["username"], properties: { username: { type: "string", pattern: USERNAME_RE } } } },
    config: { rateLimit: { max: 60, timeWindow: "1 minute", keyGenerator: (r) => `bundle:${r.user?.id ?? r.ip}` } },
  }, async (req, reply) => {
    return tx(async (c) => {
      const ik = await c.query<{ user_id: string; username: string; identity_key: Buffer; identity_key_version: number; signed_prekey_id: number; signed_prekey: Buffer; signed_prekey_signature: Buffer; signed_prekey_version: number }>(
        `SELECT k.*, u.username FROM identity_keys k JOIN users u ON u.id = k.user_id WHERE u.username = $1`, [normalizeUsername(req.params.username)]);
      const k = ik.rows[0];
      if (!k) return err(reply, 404, "not_found", "No keys published for that user.");
      // Atomic single-use hand-out; SKIP LOCKED so concurrent fetchers never get the same key.
      const otk = await c.query<{ key_id: number; public_key: Buffer; version: number }>(
        `UPDATE one_time_prekeys SET consumed_at = now() WHERE id = (
           SELECT id FROM one_time_prekeys WHERE user_id = $1 AND consumed_at IS NULL ORDER BY created_at, key_id LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING key_id, public_key, version`, [k.user_id]);
      const o = otk.rows[0];
      return reply.send({
        userId: k.user_id, username: k.username,
        identityKey: { publicKey: enc(k.identity_key), version: k.identity_key_version },
        signedPrekey: { keyId: k.signed_prekey_id, publicKey: enc(k.signed_prekey), signature: enc(k.signed_prekey_signature), version: k.signed_prekey_version },
        oneTimePrekey: o ? { keyId: o.key_id, publicKey: enc(o.public_key), version: o.version } : null,
      });
    });
  });

  // ---------- conversations ----------
  app.post<{ Body: { username: string } }>("/conversations", {
    schema: { body: { type: "object", additionalProperties: false, required: ["username"], properties: { username: { type: "string", pattern: USERNAME_RE } } } },
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
    const r = await q().query<{ id: string; kind: string; last_seq: string; created_at: Date; members: { id: string; username: string }[] }>(
      `SELECT c.id, c.kind, c.last_seq, c.created_at,
              json_agg(json_build_object('id', u.id, 'username', u.username) ORDER BY u.username) AS members
         FROM conversation_members mine
         JOIN conversations c ON c.id = mine.conversation_id
         JOIN conversation_members m ON m.conversation_id = c.id
         JOIN users u ON u.id = m.user_id
        WHERE mine.user_id = $1
        GROUP BY c.id ORDER BY c.created_at DESC LIMIT 200`, [me(req).id]);
    return { conversations: r.rows.map((c) => ({ id: c.id, kind: c.kind, lastSeq: String(c.last_seq), createdAt: new Date(c.created_at).toISOString(), members: c.members })) };
  });

  // ---------- messages ----------
  app.post<{ Params: { id: string }; Body: { clientMsgId: string; ciphertext: string; version: number } }>("/conversations/:id/messages", {
    schema: {
      params: { type: "object", required: ["id"], properties: { id: uuid } },
      body: { type: "object", additionalProperties: false, required: ["clientMsgId", "ciphertext", "version"],
        properties: { clientMsgId: { type: "string", pattern: "^[A-Za-z0-9_-]{8,64}$" }, ciphertext: b64(LIMITS.ciphertextBytes), version } },
    },
    config: { rateLimit: { max: 120, timeWindow: "1 minute", keyGenerator: (r) => `msg:${r.user?.id ?? r.ip}` } },
  }, async (req, reply) => {
    const uid = me(req).id;
    const blob = bytes(req.body.ciphertext, LIMITS.ciphertextBytes);
    if (!blob) return err(reply, 400, "invalid_ciphertext", "Ciphertext must be canonical base64 within size limits.");
    return tx(async (c) => {
      if (!(await isMember(c, req.params.id, uid))) return err(reply, 404, "not_found", "Conversation not found.");
      const dup = await c.query<MsgRow>(`SELECT * FROM messages WHERE conversation_id = $1 AND sender_id = $2 AND client_msg_id = $3`, [req.params.id, uid, req.body.clientMsgId]);
      if (dup.rows[0]) return reply.code(200).send({ message: msgDto(dup.rows[0]), duplicate: true });
      // Row lock on the conversation serializes seq allocation => gap-free, monotonic.
      const s = await c.query<{ last_seq: string }>(`UPDATE conversations SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq`, [req.params.id]);
      const m = await c.query<MsgRow>(
        `INSERT INTO messages (id, conversation_id, sender_id, seq, client_msg_id, ciphertext, version)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6) RETURNING *`,
        [req.params.id, uid, s.rows[0]?.last_seq, req.body.clientMsgId, blob, req.body.version]);
      const row = m.rows[0] as MsgRow;
      await c.query(
        `INSERT INTO message_deliveries (message_id, recipient_id) SELECT $1, user_id FROM conversation_members WHERE conversation_id = $2 AND user_id <> $3`,
        [row.id, req.params.id, uid]);
      return reply.code(201).send({ message: msgDto(row), duplicate: false });
    });
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>("/conversations/:id/messages", {
    schema: {
      params: { type: "object", required: ["id"], properties: { id: uuid } },
      querystring: { type: "object", additionalProperties: false, properties: { after: { type: "string", pattern: "^[0-9]{1,18}$" }, limit: { type: "string", pattern: "^[0-9]{1,3}$" } } },
    },
  }, async (req, reply) => {
    const uid = me(req).id;
    if (!(await isMember(q(), req.params.id, uid))) return err(reply, 404, "not_found", "Conversation not found.");
    const limit = Math.min(Math.max(Number(req.query.limit ?? LIMITS.pageSize), 1), LIMITS.pageSize);
    const r = await q().query<MsgRow & { delivered_at: Date | null }>(
      `SELECT * FROM messages WHERE conversation_id = $1 AND seq > $2::bigint ORDER BY seq LIMIT $3`, [req.params.id, req.query.after ?? "0", limit + 1]);
    const page = r.rows.slice(0, limit).map(msgDto);
    return { messages: page, nextCursor: page.length ? page[page.length - 1]?.seq : (req.query.after ?? "0"), hasMore: r.rows.length > limit };
  });

  app.post<{ Body: { messageIds: string[] } }>("/messages/ack", {
    schema: { body: { type: "object", additionalProperties: false, required: ["messageIds"],
      properties: { messageIds: { type: "array", minItems: 1, maxItems: LIMITS.ackBatch, uniqueItems: true, items: uuid } } } },
  }, async (req) => {
    // Scoped to recipient_id = caller, so acking others' or unknown ids is a silent no-op.
    const r = await q().query(
      `UPDATE message_deliveries SET delivered_at = now() WHERE recipient_id = $1 AND message_id = ANY($2::uuid[]) AND delivered_at IS NULL`,
      [me(req).id, req.body.messageIds]);
    return { acked: r.rowCount ?? 0 };
  });
}
