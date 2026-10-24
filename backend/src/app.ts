import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { db } from "./database/db.js";
import { authRoutes } from "./routes/auth.js";

// CORS allowlist: localhost dev + Vercel deployments. Tighten to the exact
// frontend domain once it is fixed (set CORS_ORIGINS=comma,separated,list).
const extra = (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const allowed = (origin: string): boolean =>
  extra.includes(origin) ||
  /^http:\/\/localhost:3000$/.test(origin) ||
  /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin);

export function buildApp(): FastifyInstance {
  // Logger: never log request bodies (credentials, ciphertext envelopes) or auth headers.
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
    },
    bodyLimit: 64 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  void app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || allowed(origin)),
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  });
  void app.register(cookie);

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
