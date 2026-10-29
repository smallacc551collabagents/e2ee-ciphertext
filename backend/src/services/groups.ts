// Group chat (Phase 6, Megolm). The server only sees membership + opaque ciphertext.
// Every membership mutation runs under a row lock on the conversation (SELECT ... FOR UPDATE), so
// concurrent changes serialize: each bumps membership_version exactly once and appends one system event.
import type { Queryable } from "../database/db.js";
import { GROUP_MAX_MEMBERS } from "@e2ee/shared";

export class GroupError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}
export type SystemEventType = "group_created" | "member_added" | "member_removed" | "member_left" | "admin_changed";
export interface GroupRow { id: string; kind: string; admin_id: string | null; membership_version: number; encrypted_meta: Buffer | null; last_seq: string; created_at: Date }

export async function lockConversation(c: Queryable, id: string): Promise<GroupRow | undefined> {
  return (await c.query<GroupRow>(`SELECT * FROM conversations WHERE id = $1 FOR UPDATE`, [id])).rows[0];
}

/** Lock a group the caller belongs to; 404 for non-members (no existence leak), 400 for direct chats. */
export async function lockGroupAsMember(c: Queryable, id: string, uid: string): Promise<GroupRow> {
  const g = await lockConversation(c, id);
  const member = g && (await c.query(`SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`, [id, uid])).rowCount;
  if (!g || !member) throw new GroupError(404, "not_found", "Conversation not found.");
  if (g.kind !== "group") throw new GroupError(400, "not_a_group", "Not a group conversation.");
  return g;
}

export async function membersOf(c: Queryable, id: string) {
  const r = await c.query<{ id: string; username: string; joined_at: Date }>(
    `SELECT u.id, u.username, m.joined_at FROM conversation_members m JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = $1 ORDER BY m.joined_at, u.id`, [id]);
  return r.rows.map((m) => ({ id: m.id, username: m.username, joinedAt: new Date(m.joined_at).toISOString() }));
}

export async function groupDto(c: Queryable, id: string) {
  const g = (await c.query<GroupRow>(`SELECT * FROM conversations WHERE id = $1`, [id])).rows[0] as GroupRow;
  return {
    id: g.id, kind: g.kind, adminId: g.admin_id, membershipVersion: g.membership_version,
    encryptedMeta: g.encrypted_meta ? Buffer.from(g.encrypted_meta).toString("base64") : null,
    lastSeq: String(g.last_seq), createdAt: new Date(g.created_at).toISOString(), members: await membersOf(c, id),
  };
}

const bump = async (c: Queryable, id: string) =>
  (await c.query<{ membership_version: number }>(
    `UPDATE conversations SET membership_version = membership_version + 1 WHERE id = $1 RETURNING membership_version`, [id])).rows[0]?.membership_version ?? 0;

/** Append a server-generated event to the seq stream, queued for every current member except the actor. */
export async function appendSystemEvent(c: Queryable, id: string, type: SystemEventType, actor: string | null, target: string | null, version: number) {
  const names = await c.query<{ id: string; username: string }>(`SELECT id, username FROM users WHERE id = ANY($1::uuid[])`, [[actor, target].filter(Boolean)]);
  const name = (u: string | null) => (u ? names.rows.find((r) => r.id === u)?.username ?? null : null);
  const event = { type, actor, actorUsername: name(actor), target, targetUsername: name(target), membershipVersion: version };
  const s = await c.query<{ last_seq: string }>(`UPDATE conversations SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq`, [id]);
  const m = await c.query<{ id: string }>(
    `INSERT INTO messages (id, conversation_id, sender_id, seq, client_msg_id, ciphertext, version, system_event)
     VALUES (gen_random_uuid(), $1, NULL, $2, 'sys-' || gen_random_uuid()::text, '\\x'::bytea, 1, $3::jsonb) RETURNING id`,
    [id, s.rows[0]?.last_seq, JSON.stringify(event)]);
  await c.query(
    `INSERT INTO message_deliveries (message_id, recipient_id) SELECT $1, user_id FROM conversation_members
      WHERE conversation_id = $2 AND ($3::uuid IS NULL OR user_id <> $3::uuid)`, [m.rows[0]?.id, id, actor]);
}

/** Users the adder may add: must exist and share a 1:1 conversation with the adder. */
export async function resolveContacts(c: Queryable, adderId: string, usernames: string[]) {
  const r = await c.query<{ id: string; username: string; contact: boolean }>(
    `SELECT u.id, u.username, EXISTS (SELECT 1 FROM conversations d WHERE d.kind = 'direct'
              AND d.direct_key = LEAST(u.id::text, $1::text) || ':' || GREATEST(u.id::text, $1::text)) AS contact
       FROM users u WHERE u.username = ANY($2::text[])`, [adderId, usernames]);
  const bad = usernames.filter((n) => !r.rows.some((x) => x.username === n && x.contact && x.id !== adderId));
  if (bad.length) throw new GroupError(403, "not_a_contact", "You can only add people you already have a 1:1 chat with.", { usernames: bad });
  return r.rows;
}

/** Insert members (caller holds the lock). Enforces the cap; re-adding a former member gets a fresh joined_at/joined_seq. */
export async function addMembers(c: Queryable, g: GroupRow, actor: string, users: { id: string; username: string }[], emitEvents = true) {
  const cur = await c.query<{ user_id: string }>(`SELECT user_id FROM conversation_members WHERE conversation_id = $1`, [g.id]);
  const dup = users.filter((u) => cur.rows.some((r) => r.user_id === u.id));
  if (dup.length) throw new GroupError(409, "already_member", "Already in the group.", { usernames: dup.map((u) => u.username) });
  if (cur.rows.length + users.length > GROUP_MAX_MEMBERS) throw new GroupError(409, "group_full", `Groups are limited to ${GROUP_MAX_MEMBERS} members.`);
  let v = g.membership_version;
  for (const u of users) {
    const seq = (await c.query<{ last_seq: string }>(`SELECT last_seq FROM conversations WHERE id = $1`, [g.id])).rows[0]?.last_seq ?? "0";
    // joined_seq = seq before the join event, so the new member sees their own "added" line but no history.
    await c.query(`INSERT INTO conversation_members (conversation_id, user_id, joined_at, joined_seq) VALUES ($1, $2, clock_timestamp(), $3)`, [g.id, u.id, seq]);
    if (emitEvents) { v = await bump(c, g.id); await appendSystemEvent(c, g.id, "member_added", actor, u.id, v); }
  }
  return v;
}

/**
 * Remove target (kick or leave). Caller holds the lock. Drops the target's pending deliveries, transfers admin
 * to the oldest remaining member if needed, and deletes the group when nobody is left (returns attachment refs).
 */
export async function removeMember(c: Queryable, g: GroupRow, actor: string | null, target: string, type: "member_removed" | "member_left"): Promise<{ deleted: boolean; refs: string[] }> {
  await c.query(`DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`, [g.id, target]);
  await c.query(
    `DELETE FROM message_deliveries d USING messages m WHERE d.message_id = m.id AND m.conversation_id = $1 AND d.recipient_id = $2`, [g.id, target]);
  const left = await c.query<{ user_id: string }>(
    `SELECT user_id FROM conversation_members WHERE conversation_id = $1 ORDER BY joined_at, user_id`, [g.id]);
  if (!left.rows.length) {
    const refs = await c.query<{ ref: string }>(`DELETE FROM attachments WHERE conversation_id = $1 RETURNING ref`, [g.id]);
    await c.query(`DELETE FROM conversations WHERE id = $1`, [g.id]); // cascades messages/deliveries/members
    return { deleted: true, refs: refs.rows.map((r) => r.ref) };
  }
  let v = await bump(c, g.id);
  await appendSystemEvent(c, g.id, type, actor, target, v);
  if (g.admin_id === target) {
    const next = left.rows[0]?.user_id as string;
    await c.query(`UPDATE conversations SET admin_id = $2 WHERE id = $1`, [g.id, next]);
    v = await bump(c, g.id);
    await appendSystemEvent(c, g.id, "admin_changed", null, next, v);
  }
  return { deleted: false, refs: [] };
}

/** Account deletion: leave every group with the same admin-transfer / last-member rules. */
export async function leaveAllGroups(c: Queryable, userId: string): Promise<string[]> {
  const gs = await c.query<{ id: string }>(
    `SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
      WHERE m.user_id = $1 AND c.kind = 'group' ORDER BY c.id`, [userId]);
  const refs: string[] = [];
  for (const { id } of gs.rows) {
    const g = await lockConversation(c, id);
    if (g) refs.push(...(await removeMember(c, g, userId, userId, "member_left")).refs);
  }
  return refs;
}
