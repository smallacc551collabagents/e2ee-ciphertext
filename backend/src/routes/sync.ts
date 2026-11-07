// Realtime doorbell without websockets: authenticated long-poll. Read-only — never acks/consumes.
// Clients call the existing endpoints (/conversations, /conversations/:id/messages, /to-device) after a wake.
//
// Cursor v3: "v3.<memberCount>.<sumMembershipVersion>.<maxJoinedMs>.<msgMaxMs>.<msgCount>.<tdMaxMs>.<tdCount>.<deliveredMaxMs>".
// deliveredMaxMs = newest conversation_members.delivered_at in my conversations; `delivered` lists
// conversations whose watermark advanced since then (grey ticks). v1/v2 cursors return immediately.
// The last four are high-water marks of what the caller was already told about: pending (undelivered,
// non-flagged) messages and pending to-device messages. Items can stay pending on purpose (e.g. waiting for
// a room key), so with `since` we only wake for NEWER items (created_at > mark, or count grew) or a
// membership change. Without `since` (or with a v1 cursor) we return immediately listing all pending.
import type { FastifyInstance } from "fastify";
import { q } from "../database/db.js";
import { me, requireAuth } from "../middleware/requireAuth.js";
import { shared } from "../utils/sharedSchema.js";
import { SYNC_WAIT_MAX_SECONDS, syncWaitQuerySchema, type SyncWaitResponse } from "@e2ee/shared";

// Poll tick; override with SYNC_POLL_MS (tests also set SYNC.pollMs directly).
export const SYNC = { pollMs: Number(process.env.SYNC_POLL_MS) > 0 ? Number(process.env.SYNC_POLL_MS) : 300, maxSeconds: SYNC_WAIT_MAX_SECONDS };

interface Row {
  pend: { c: string; t: string }[] | null; msg_n: string; msg_t: string; td_n: string; td_t: string;
  n: string; vsum: string; maxj: string; newconv: string[] | null; dl_t: string; dl: string[] | null;
}
const ms = (col: string) => `floor(extract(epoch FROM ${col}) * 1000)::bigint`;

// One small query per tick, all on existing indexes: deliveries (recipient_id, delivered_at),
// to-device (recipient_id, created_at), memberships (user_id).
async function probe(uid: string, sinceJoinedMs: string, sinceDeliveredMs: string): Promise<Row> {
  const r = await q().query<Row>(
    `WITH p AS (SELECT m.conversation_id::text AS c, max(${ms("m.created_at")}) AS t, count(*) AS k
                  FROM message_deliveries d JOIN messages m ON m.id = d.message_id JOIN conversations cv ON cv.id = m.conversation_id
                 WHERE d.recipient_id = $1 AND d.delivered_at IS NULL AND (d.undeliverable_reason IS NULL OR cv.kind = 'group')
                 GROUP BY m.conversation_id),
          td AS (SELECT count(*) AS n, coalesce(max(${ms("created_at")}), 0) AS t FROM to_device_messages WHERE recipient_id = $1),
          dl AS (SELECT o.conversation_id::text AS c, max(${ms("o.delivered_at")}) AS t
                   FROM conversation_members cm JOIN conversation_members o ON o.conversation_id = cm.conversation_id
                  WHERE cm.user_id = $1 AND o.user_id <> $1 AND o.delivered_at IS NOT NULL GROUP BY o.conversation_id),
          s AS (SELECT count(*) AS n, coalesce(sum(c.membership_version), 0) AS vsum, coalesce(max(${ms("cm.joined_at")}), 0) AS maxj
                  FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id WHERE cm.user_id = $1)
     SELECT (SELECT json_agg(json_build_object('c', c, 't', t::text)) FROM p) AS pend,
            (SELECT coalesce(sum(k), 0)::text FROM p) AS msg_n, (SELECT coalesce(max(t), 0)::text FROM p) AS msg_t,
            td.n::text AS td_n, td.t::text AS td_t, s.n::text AS n, s.vsum::text AS vsum, s.maxj::text AS maxj,
            (SELECT array_agg(cm.conversation_id::text) FROM conversation_members cm
              WHERE cm.user_id = $1 AND ${ms("cm.joined_at")} > $2::bigint) AS newconv,
            (SELECT coalesce(max(t), 0)::text FROM dl) AS dl_t,
            (SELECT array_agg(c) FROM dl WHERE t > $3::bigint) AS dl
       FROM td, s`, [uid, sinceJoinedMs, sinceDeliveredMs]);
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
    const since = req.query.since?.startsWith("v3.") ? req.query.since.split(".") : undefined; // v1/v2 => like no since
    const [, sN, sV, sJ, sMt, sMn, sTt, sTn, sDt] = since ?? [];
    let closed = false;
    const onClose = () => { closed = true; };
    req.raw.on("close", onClose);
    reply.header("Cache-Control", "no-store");
    const deadline = Date.now() + timeout * 1000;
    try {
      for (;;) {
        const r = await probe(uid, sJ ?? "0", sDt ?? "0");
        const cursor = `v3.${r.n}.${r.vsum}.${r.maxj}.${r.msg_t}.${r.msg_n}.${r.td_t}.${r.td_n}.${r.dl_t}`;
        const pend = r.pend ?? [];
        let body: SyncWaitResponse;
        if (!since) {
          body = { changed: pend.length > 0 || r.td_n !== "0", cursor, conversations: pend.map((p) => p.c), toDevice: r.td_n !== "0" };
        } else {
          const big = (x: string) => BigInt(x);
          const membership = r.n !== sN || r.vsum !== sV || r.maxj !== sJ;
          const msgCountGrew = big(r.msg_n) > big(sMn!);
          const newer = pend.filter((p) => big(p.t) > big(sMt!)).map((p) => p.c);
          const convs = msgCountGrew && newer.length === 0 ? pend.map((p) => p.c) : newer;
          const toDevice = big(r.td_t) > big(sTt!) || big(r.td_n) > big(sTn!);
          const conversations = [...new Set([...convs, ...(r.newconv ?? [])])];
          const delivered = r.dl ?? [];
          body = { changed: membership || conversations.length > 0 || toDevice || delivered.length > 0, cursor, conversations, toDevice, ...(delivered.length ? { delivered } : {}) };
        }
        const left = deadline - Date.now();
        if (body.changed || !since || closed || left <= 0) return body;
        await new Promise((res) => setTimeout(res, Math.min(SYNC.pollMs, left)));
        if (closed) return reply.code(499).send(); // client went away; stop polling
      }
    } finally {
      req.raw.off("close", onClose);
    }
  });
}
