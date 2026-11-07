// Last seen (server-side presence metadata; read receipts are E2EE via /to-device, not here).
import { q, type Queryable } from "../database/db.js";
import { PRESENCE_ONLINE_SECONDS } from "@e2ee/shared";

export const PRESENCE = { throttleSeconds: 30, onlineSeconds: PRESENCE_ONLINE_SECONDS };

/** Throttled touch: writes at most once per throttleSeconds per user. Never throws. */
export async function touchLastSeen(userId: string): Promise<void> {
  try {
    await q().query(
      `UPDATE users SET last_seen_at = now() WHERE id = $1
         AND (last_seen_at IS NULL OR last_seen_at < now() - make_interval(secs => $2))`, [userId, PRESENCE.throttleSeconds]);
  } catch { /* presence is best-effort; never fail the request */ }
}

/**
 * Advance this recipient's delivery watermark in the given conversations: highest seq such that every
 * message addressed to them up to it was acked (= min pending seq - 1, or last_seq when nothing is pending).
 * Monotonic (GREATEST); delivered_at only moves when the watermark does.
 */
export async function advanceDelivered(c: Queryable, userId: string, conversationIds: string[]): Promise<void> {
  if (!conversationIds.length) return;
  await c.query(
    `WITH w AS (
       SELECT cm.conversation_id,
              coalesce((SELECT min(m.seq) - 1 FROM message_deliveries d JOIN messages m ON m.id = d.message_id
                         WHERE d.recipient_id = $1 AND d.delivered_at IS NULL AND m.conversation_id = cm.conversation_id),
                       cv.last_seq) AS seq
         FROM conversation_members cm JOIN conversations cv ON cv.id = cm.conversation_id
        WHERE cm.user_id = $1 AND cm.conversation_id = ANY($2::uuid[]))
     UPDATE conversation_members cm SET delivered_seq = w.seq, delivered_at = now()
       FROM w WHERE cm.conversation_id = w.conversation_id AND cm.user_id = $1 AND w.seq > cm.delivered_seq`,
    [userId, conversationIds]);
}
