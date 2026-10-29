import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { db } from "./database/db.js";
import { authRoutes } from "./routes/auth.js";
import { transportRoutes } from "./routes/transport.js";
import { groupRoutes } from "./routes/groups.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { syncRoutes } from "./routes/sync.js";

import rateLimit from "@fastify/rate-limit";
import { SharedStore, setRateLimitLogger } from "./utils/rateLimiter.js";

// CORS allowlist: ONLY http://localhost:3000 plus exact origins in CORS_ORIGINS
// (comma-separated). No wildcard *.vercel.app matching.
const allowedOrigins = new Set([
  "http://localhost:3000",
  ...(process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
]);
const allowed = (origin: string): boolean => allowedOrigins.has(origin);

export function buildApp(): FastifyInstance {
  // Logger: never log request bodies (credentials, ciphertext envelopes) or auth headers.
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-proxy-secret"]', 'res.headers["set-cookie"]'],
    },
    bodyLimit: 64 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  void app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || allowed(origin)),
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    maxAge: 600,
  });
  // Security headers on every response (API/JSON only, so a strict CSP is safe).
  // onSend runs for CORS preflight replies too; these headers don't affect CORS.
  app.addHook("onSend", async (_req, reply, payload) => {
    void reply.header("X-Content-Type-Options", "nosniff");
    void reply.header("X-Frame-Options", "DENY");
    void reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    return payload;
  });
  void app.register(cookie);
  // Rate limiting is opt-in per route (global: false); see routes/auth.ts.
  // E2EE-75: counters live in the shared Postgres store (utils/rateLimiter.ts), so limits
  // survive cold starts and apply across instances. skipOnError is set per route.
  setRateLimitLogger((e) => app.log.error({ err: { name: (e as Error)?.name } }, "rate-limit cleanup failed"));
  void app.register(rateLimit, { global: false, store: SharedStore as never });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err.validation) {
      return reply.code(400).send({ error: "validation_error", message: err.message });
    }
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err: { name: err.name, code: err.code } }, "unhandled error");
    // Never leak stack traces or internal messages.
    return reply.code(status).send({
      error: status >= 500 ? "internal_error" : "bad_request",
      message: status >= 500 ? "Something went wrong." : err.message,
    });
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await db().query("SELECT 1");
      return reply.send({ status: "ready", db: "ok" });
    } catch {
      return reply.code(503).send({ status: "not_ready", db: "unreachable" });
    }
  });

  void app.register(authRoutes, { prefix: "/auth" });
  void app.register(transportRoutes);
  void app.register(groupRoutes);
  void app.register(attachmentRoutes);
  void app.register(syncRoutes);

  // TODO(Phase 0): authenticated WebSocket doorbell (backend/src/websocket).
  return app;
}
