// Last seen: heartbeat for open tabs + privacy toggle. Presence itself is read via GET /conversations members.
import type { FastifyInstance } from "fastify";
import { q } from "../database/db.js";
import { me, requireAuth } from "../middleware/requireAuth.js";
import { shared } from "../utils/sharedSchema.js";
import { privacyRequestSchema } from "@e2ee/shared";

export async function presenceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth); // requireAuth already does the throttled last_seen touch

  app.post("/presence/heartbeat", {
    config: { rateLimit: { hook: "preHandler", skipOnError: true, max: 30, timeWindow: "1 minute", keyGenerator: (r) => `hb:${r.user?.id ?? r.ip}` } },
  }, async (_req, reply) => reply.code(204).send());

  app.get("/me/privacy", async (req) => {
    const r = await q().query<{ hide_last_seen: boolean }>(`SELECT hide_last_seen FROM users WHERE id = $1`, [me(req).id]);
    return { hideLastSeen: !!r.rows[0]?.hide_last_seen };
  });

  app.put<{ Body: { hideLastSeen: boolean } }>("/me/privacy", {
    ...shared({ body: privacyRequestSchema }),
  }, async (req) => {
    const r = await q().query<{ hide_last_seen: boolean }>(
      `UPDATE users SET hide_last_seen = $2 WHERE id = $1 RETURNING hide_last_seen`, [me(req).id, req.body.hideLastSeen]);
    return { hideLastSeen: !!r.rows[0]?.hide_last_seen };
  });
}
