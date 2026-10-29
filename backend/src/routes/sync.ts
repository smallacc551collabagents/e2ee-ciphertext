// Realtime doorbell without websockets: authenticated long-poll. Read-only — never acks/consumes.
// Clients call the existing endpoints (/conversations, /conversations/:id/messages, /to-device) after a wake.
import type { FastifyInstance } from "fastify";
import { q } from "../database/db.js";
import { me, requireAuth } from "../middleware/requireAuth.js";
import { shared } from "../utils/sharedSchema.js";
import { SYNC_WAIT_MAX_SECONDS, syncWaitQuerySchema, type SyncWaitResponse } from "@e2ee/shared";

export const SYNC = { pollMs: 1000, maxSeconds: SYNC_WAIT_MAX_SECONDS };

interface Row { pending: string[] | null; to_device: boolean; n: string; vsum: string; maxj: string; newconv: string[] | null }

// One small indexed query per tick: deliveries via (recipient_id, delivered_at), to-device via
// (recipient_id, created_at), memberships via (user_id). Membership cursor = count, sum(membership_version),
// max(joined_at ms) over my memberships — changes on join, leave/removal, and any group roster change.
async function probe(uid: string, sinceJoinedMs: string): Promise<Row> {
  const r = await q().query<Row>(
    `SELECT
       (SELECT array_agg(DISTINCT m.conversation_id::text) FROM message_deliveries d JOIN messages m ON m.id = d.message_id
         WHERE d.recipient_id = $1 AND d.delivered_at IS NULL AND d.undeliverable_reason IS NULL) AS pending,
       EXISTS (SELECT 1 FROM to_device_messages t WHERE t.recipient_id = $1) AS to_device,
       s.n::text AS n, s.vsum::text AS vsum, s.maxj::text AS maxj,
       (SELECT array_agg(cm.conversation_id::text) FROM conversation_members cm
         WHERE cm.user_id = $1 AND floor(extract(epoch FROM cm.joined_at) * 1000) > $2::bigint) AS newconv
     FROM (SELECT count(*) AS n, coalesce(sum(c.membership_version), 0) AS vsum,
                  coalesce(floor(max(extract(epoch FROM cm.joined_at)) * 1000), 0)::bigint AS maxj
             FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id WHERE cm.user_id = $1) s`,
    [uid, sinceJoinedMs]);
  return r.rows[0]!;
}

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.get<{ Querystring: { since?: string; timeout?: string } }>("/sync/wait", {
    ...shared({ querystring: syncWaitQuerySchema }),
    config: { rateLimit: { hook: "preHandler", skipOnError: true, max: 120, timeWindow: "1 minute", keyGenerator: (r) => `sync:${r.user?.id ?? r.ip}` } },
  }, async (req, reply) => {
    const uid = me(req).id;
    const timeout = Math.min(Number(req.query.timeout ?? SYNC.maxSeconds), SYNC.maxSeconds);
    const since = req.query.since;
    const sinceJoined = since ? since.split(".")[3]! : "0";
    let closed = false;
    const onClose = () => { closed = true; };
    req.raw.on("close", onClose);
    reply.header("Cache-Control", "no-store");
    const deadline = Date.now() + timeout * 1000;
    try {
      for (;;) {
        const r = await probe(uid, sinceJoined);
        const cursor = `v1.${r.n}.${r.vsum}.${r.maxj}`;
        const membershipChanged = since !== undefined && since !== cursor;
        const conversations = [...new Set([...(r.pending ?? []), ...(since !== undefined ? (r.newconv ?? []) : [])])];
        const changed = conversations.length > 0 || r.to_device || membershipChanged;
        const body: SyncWaitResponse = { changed, cursor, conversations, toDevice: r.to_device };
        // No `since` = bootstrap: return the current cursor right away.
        const left = deadline - Date.now();
        if (changed || since === undefined || closed || left <= 0) return body;
        await new Promise((res) => setTimeout(res, Math.min(SYNC.pollMs, left)));
        if (closed) return reply.code(499).send(); // client went away; stop polling
      }
    } finally {
      req.raw.off("close", onClose);
    }
  });
}
