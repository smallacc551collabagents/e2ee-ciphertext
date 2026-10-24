import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";

// Readiness probe uses a tiny pg pool; Prisma client generation waits for Phase 1 models.
let pool: pg.Pool | undefined;
const db = (): pg.Pool =>
  (pool ??= new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
  }));

export function buildApp(): FastifyInstance {
  // Logger: never log request bodies (ciphertext envelopes) or auth material.
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_req, reply) => {
    try {
      await db().query("SELECT 1");
      return reply.send({ status: "ready", db: "ok" });
    } catch {
      return reply.code(503).send({ status: "not_ready", db: "unreachable" });
    }
  });

  // TODO(Phase 0): auth/session middleware (backend/src/middleware).
  // TODO(Phase 0): authenticated WebSocket doorbell (backend/src/websocket).
  return app;
}
