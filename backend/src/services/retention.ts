// Message retention: the server is a store-and-forward relay, not an archive.
// - A message's ciphertext is deleted once EVERY recipient has acked it (delivered_at set).
// - Unacked messages are dropped 30 days after send (matches attachment retention).
// Deletes are bounded (RETENTION.batch rows per call) and run opportunistically (~5% of calls),
// plus an immediate targeted delete of the just-acked messages in /messages/ack.
import { q, type Queryable } from "../database/db.js";

export const RETENTION = {
  undeliveredTtlDays: 30,
  batch: 500,
  probability: 0.05,
} as const;

/** Delete the given messages if no recipient is still pending. */
export async function deleteFullyAcked(ids: string[], c: Queryable = q()): Promise<number> {
  if (!ids.length) return 0;
  const r = await c.query(
    `DELETE FROM messages m WHERE m.id = ANY($1::uuid[])
       AND NOT EXISTS (SELECT 1 FROM message_deliveries d WHERE d.message_id = m.id AND d.delivered_at IS NULL)`, [ids]);
  return r.rowCount ?? 0;
}

/** Bounded sweep: fully-acked messages, then messages older than the undelivered TTL. */
export async function sweepMessages(limit: number = RETENTION.batch): Promise<number> {
  const acked = await q().query(
    `DELETE FROM messages WHERE id IN (
       SELECT m.id FROM messages m
        WHERE NOT EXISTS (SELECT 1 FROM message_deliveries d WHERE d.message_id = m.id AND d.delivered_at IS NULL)
        LIMIT $1)`, [limit]);
  const old = await q().query(
    `DELETE FROM messages WHERE id IN (
       SELECT id FROM messages WHERE created_at < now() - make_interval(days => $2) ORDER BY created_at LIMIT $1)`,
    [limit, RETENTION.undeliveredTtlDays]);
  const stale = await q().query(
    `DELETE FROM resend_needed WHERE ctid IN (
       SELECT ctid FROM resend_needed WHERE created_at < now() - make_interval(days => $2) LIMIT $1)`,
    [limit, RETENTION.undeliveredTtlDays]);
  return (acked.rowCount ?? 0) + (old.rowCount ?? 0) + (stale.rowCount ?? 0);
}
