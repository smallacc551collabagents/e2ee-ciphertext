// Group chat + to-device routes (Phase 6). Contracts live in @e2ee/shared.
import type { FastifyInstance, FastifyReply } from "fastify";
import { q, tx, type Queryable } from "../database/db.js";
import { me, requireAuth } from "../middleware/requireAuth.js";
import { normalizeUsername } from "../services/auth.js";
import { objectStore } from "../services/objectStore.js";
import { shared } from "../utils/sharedSchema.js";
import {
  addMembers, appendSystemEvent, GroupError, groupDto, lockConversation, lockGroupAsMember, removeMember, resolveContacts,
} from "../services/groups.js";
import {
  addGroupMembersRequestSchema, CIPHERTEXT_MAX_BYTES, conversationParamsSchema, createGroupRequestSchema, GROUP_META_MAX_BYTES,
  groupMemberParamsSchema, sendToDeviceRequestSchema, toDeviceAckRequestSchema, toDeviceQuerySchema,
} from "@e2ee/shared";

export const TO_DEVICE = { ttlDays: 30, pageSize: 100 } as const;

function bytes(s: string, max: number): Buffer | null {
  const b = Buffer.from(s, "base64");
  if (b.length === 0 || b.length > max || b.toString("base64") !== s) return null;
  return b;
}

async function run<T>(reply: FastifyReply, fn: (c: Queryable) => Promise<T>): Promise<T | FastifyReply> {
  try { return await tx(fn); } catch (e) {
    if (e instanceof GroupError) return reply.code(e.status).send({ error: e.code, message: e.message, ...e.extra });
    throw e;
  }
}

export async function groupRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);
  const dropBlobs = async (refs: string[]) => {
    for (const ref of refs) {
      try { await objectStore().delete(`a/${ref}`); } catch (e) { app.log.error({ err: { name: (e as Error)?.name } }, "group delete: blob delete failed"); }
    }
  };
  const rl = (name: string, max: number) => ({ rateLimit: { hook: "preHandler" as const, skipOnError: true, max, timeWindow: "1 minute", keyGenerator: (r: { user?: { id: string }; ip: string }) => `${name}:${r.user?.id ?? r.ip}` } });

  app.post<{ Body: { members: string[]; encryptedMeta?: string } }>("/groups", {
    ...shared({ body: createGroupRequestSchema }), config: rl("group-create", 20),
  }, async (req, reply) => {
    const uid = me(req).id;
    const meta = req.body.encryptedMeta ? bytes(req.body.encryptedMeta, GROUP_META_MAX_BYTES) : null;
    if (req.body.encryptedMeta && !meta) return reply.code(400).send({ error: "invalid_meta", message: "encryptedMeta must be canonical base64 within size limits." });
    const names = req.body.members.map(normalizeUsername);
    return run(reply, async (c) => {
      const users = await resolveContacts(c, uid, names);
      const g = (await c.query<{ id: string }>(
        `INSERT INTO conversations (id, kind, admin_id, encrypted_meta, membership_version) VALUES (gen_random_uuid(), 'group', $1, $2, 1) RETURNING id`, [uid, meta])).rows[0];
      const id = g?.id as string;
      await c.query(`INSERT INTO conversation_members (conversation_id, user_id, joined_at, joined_seq) VALUES ($1, $2, clock_timestamp(), 0)`, [id, uid]);
      const row = await lockConversation(c, id);
      if (row) await addMembers(c, row, uid, users, false);
      await appendSystemEvent(c, id, "group_created", uid, null, 1);
      return reply.code(201).send({ conversation: await groupDto(c, id) });
    });
  });

  app.post<{ Params: { id: string }; Body: { usernames: string[] } }>("/groups/:id/members", {
    ...shared({ params: conversationParamsSchema, body: addGroupMembersRequestSchema }), config: rl("group-members", 60),
  }, async (req, reply) => {
    const uid = me(req).id;
    return run(reply, async (c) => {
      const g = await lockGroupAsMember(c, req.params.id, uid);
      const users = await resolveContacts(c, uid, req.body.usernames.map(normalizeUsername));
      await addMembers(c, g, uid, users);
      return { conversation: await groupDto(c, g.id) };
    });
  });

  app.delete<{ Params: { id: string; username: string } }>("/groups/:id/members/:username", {
    ...shared({ params: groupMemberParamsSchema }), config: rl("group-members", 60),
  }, async (req, reply) => {
    const uid = me(req).id;
    const out = await run(reply, async (c) => {
      const g = await lockGroupAsMember(c, req.params.id, uid);
      const t = (await c.query<{ id: string }>(
        `SELECT u.id FROM users u JOIN conversation_members m ON m.user_id = u.id AND m.conversation_id = $1 WHERE u.username = $2`,
        [g.id, normalizeUsername(req.params.username)])).rows[0];
      if (!t) throw new GroupError(404, "not_member", "That user is not in this group.");
      if (t.id === g.admin_id) throw new GroupError(403, "cannot_remove_admin", "The group admin cannot be removed.");
      if (t.id === uid) throw new GroupError(400, "use_leave", "Use POST /groups/:id/leave to leave.");
      await removeMember(c, g, uid, t.id, "member_removed");
      return { conversation: await groupDto(c, g.id) };
    });
    return out;
  });

  app.post<{ Params: { id: string } }>("/groups/:id/leave", {
    ...shared({ params: conversationParamsSchema }), config: rl("group-members", 60),
  }, async (req, reply) => {
    const uid = me(req).id;
    let refs: string[] = [];
    const out = await run(reply, async (c) => {
      const g = await lockGroupAsMember(c, req.params.id, uid);
      const r = await removeMember(c, g, uid, uid, "member_left");
      refs = r.refs;
      return { left: true, groupDeleted: r.deleted };
    });
    await dropBlobs(refs);
    return out;
  });

  // ---------- to-device (Olm envelopes carrying Megolm room keys) ----------
  app.post<{ Body: { messages: { recipient: string; ciphertext: string; type: number; version: number }[] } }>("/to-device", {
    bodyLimit: 4 * 1024 * 1024,
    ...shared({ body: sendToDeviceRequestSchema }), config: rl("to-device", 120),
  }, async (req, reply) => {
    const uid = me(req).id;
    const msgs = req.body.messages.map((m) => ({ ...m, recipient: normalizeUsername(m.recipient), b: bytes(m.ciphertext, CIPHERTEXT_MAX_BYTES) }));
    if (msgs.some((m) => !m.b)) return reply.code(400).send({ error: "invalid_ciphertext", message: "Ciphertext must be canonical base64 within size limits." });
    const names = [...new Set(msgs.map((m) => m.recipient))];
    // Allowed recipients: users sharing ANY conversation (1:1 or group) with the sender.
    const ok = await q().query<{ id: string; username: string }>(
      `SELECT DISTINCT u.id, u.username FROM users u
         JOIN conversation_members theirs ON theirs.user_id = u.id
         JOIN conversation_members mine ON mine.conversation_id = theirs.conversation_id AND mine.user_id = $1
        WHERE u.username = ANY($2::text[]) AND u.id <> $1`, [uid, names]);
    const bad = names.filter((n) => !ok.rows.some((r) => r.username === n));
    if (bad.length) return reply.code(403).send({ error: "not_a_contact", message: "Recipients must share a conversation with you.", usernames: bad });
    const idOf = new Map(ok.rows.map((r) => [r.username, r.id]));
    await q().query(
      `INSERT INTO to_device_messages (id, sender_id, recipient_id, ciphertext, type, version)
       SELECT gen_random_uuid(), $1, r, c, t, v FROM unnest($2::uuid[], $3::bytea[], $4::int[], $5::int[]) AS x(r, c, t, v)`,
      [uid, msgs.map((m) => idOf.get(m.recipient)), msgs.map((m) => m.b), msgs.map((m) => m.type), msgs.map((m) => m.version)]);
    if (Math.random() < 0.05) await q().query(`DELETE FROM to_device_messages WHERE created_at < now() - make_interval(days => $1)`, [TO_DEVICE.ttlDays]).catch(() => undefined);
    return reply.code(201).send({ sent: msgs.length });
  });

  app.get<{ Querystring: { limit?: string } }>("/to-device", {
    ...shared({ querystring: toDeviceQuerySchema }), config: rl("to-device-get", 240),
  }, async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? TO_DEVICE.pageSize), 1), TO_DEVICE.pageSize);
    const r = await q().query<{ id: string; sender_id: string; username: string; ciphertext: Buffer; type: number; version: number; created_at: Date }>(
      `SELECT t.*, u.username FROM to_device_messages t JOIN users u ON u.id = t.sender_id
        WHERE t.recipient_id = $1 AND t.created_at >= now() - make_interval(days => $3)
        ORDER BY t.created_at, t.id LIMIT $2`, [me(req).id, limit + 1, TO_DEVICE.ttlDays]);
    return {
      messages: r.rows.slice(0, limit).map((t) => ({
        id: t.id, senderId: t.sender_id, senderUsername: t.username, ciphertext: Buffer.from(t.ciphertext).toString("base64"),
        type: t.type, version: t.version, createdAt: new Date(t.created_at).toISOString(),
      })),
      hasMore: r.rows.length > limit,
    };
  });

  app.post<{ Body: { ids: string[] } }>("/to-device/ack", { ...shared({ body: toDeviceAckRequestSchema }) }, async (req) => {
    const r = await q().query(`DELETE FROM to_device_messages WHERE recipient_id = $1 AND id = ANY($2::uuid[])`, [me(req).id, req.body.ids]);
    return { acked: r.rowCount ?? 0 };
  });
}
