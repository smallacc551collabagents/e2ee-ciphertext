import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { db } from "./database/db.js";
import { authRoutes } from "./routes/auth.js";

import rateLimit from "@fastify/rate-limit";

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
  void app.register(cookie);
  // Rate limiting is opt-in per route (global: false); see routes/auth.ts.
  // In-memory store: resets per serverless cold start — acceptable interim, Redis later.
  void app.register(rateLimit, { global: false });

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

  // TODO(Phase 0): authenticated WebSocket doorbell (backend/src/websocket).
  return app;
}
