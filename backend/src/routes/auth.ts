import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as auth from "../services/auth.js";
import { clientIp } from "../utils/clientIp.js";
import { tx } from "../database/db.js";
import { objectStore } from "../services/objectStore.js";
import { shared } from "../utils/sharedSchema.js";
import { deleteAccountRequestSchema } from "@e2ee/shared";
import { recordFailure, recordSuccess, usernameLocked } from "../utils/usernameLimiter.js";

import { SESSION_COOKIE } from "../middleware/requireAuth.js";
export { SESSION_COOKIE };

const username = { type: "string", pattern: auth.USERNAME_RE } as const;
const password = { type: "string", minLength: auth.PASSWORD_MIN, maxLength: auth.PASSWORD_MAX } as const;
const credsBody = {
  type: "object", additionalProperties: false, required: ["username", "password"],
  properties: { username, password },
} as const;

type Creds = { username: string; password: string };

// Cookie is first-party via the frontend /api proxy: SameSite=Lax, no Domain attribute.
const COOKIE_BASE = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;

// E2EE-69 / ARCH-014: the httpOnly cookie is the ONLY session carrier; the token is
// never returned in a response body.
function issue(reply: FastifyReply, s: { token: string; expiresAt: Date }) {
  reply.setCookie(SESSION_COOKIE, s.token, { ...COOKIE_BASE, expires: s.expiresAt });
  return { expiresAt: s.expiresAt.toISOString() };
}

function clearSession(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, COOKIE_BASE);
}

// Cookie only — no Bearer/Authorization header path.
function tokenFrom(req: FastifyRequest): string | undefined {
  return req.cookies[SESSION_COOKIE];
}

const isProd = () => process.env.NODE_ENV === "production";

// E2EE-68 / ARCH-013: per-IP limit on signin+signup (IP trusted from x-forwarded-for
// only with a valid x-proxy-secret). E2EE-75: counted in the shared Postgres store.
// Fails CLOSED: if the limiter store errors, the request errors (500) rather than
// letting credential guessing through unthrottled. Signin/signup need the DB anyway.
const ipLimit = {
  rateLimit: {
    max: 20,
    skipOnError: false,
    timeWindow: "15 minutes",
    keyGenerator: (req: FastifyRequest) => `auth:${clientIp(req)}`,
    errorResponseBuilder: (_req: FastifyRequest, ctx: { after: string; statusCode: number }) => ({
      statusCode: 429, error: "rate_limited", message: `Too many attempts. Try again in ${ctx.after}.`,
    }),
  },
} as const;

const tooMany = (reply: FastifyReply, retryAfter: number) =>
  reply.code(429).header("retry-after", String(retryAfter))
    .send({ statusCode: 429, error: "rate_limited", message: "Too many attempts. Try again later." });

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: Creds }>("/signup", { schema: { body: credsBody }, config: ipLimit }, async (req, reply) => {
    const user = await auth.createUser(auth.normalizeUsername(req.body.username), req.body.password);
    if (!user) return reply.code(409).send({ error: "username_taken", message: "Username is already taken." });
    const session = await auth.createSession(user.id);
    return reply.code(201).send({ user, session: issue(reply, session) });
  });

  app.post<{ Body: Creds }>("/signin", { schema: { body: credsBody }, config: ipLimit }, async (req, reply) => {
    const uname = auth.normalizeUsername(req.body.username);
    // Per-username lockout: same 429 whether or not the account exists.
    const locked = await usernameLocked(uname);
    if (locked) return tooMany(reply, locked);
    const row = await auth.findUserForLogin(uname);
    const ok = await auth.verifyPassword(row?.password_hash, req.body.password);
    if (!row || !ok) await recordFailure(uname);
    else await recordSuccess(uname);
    if (!row || !ok) return reply.code(401).send({ error: "invalid_credentials", message: "Invalid username or password." });
    const session = await auth.createSession(row.id);
    return reply.send({
      user: { id: row.id, username: row.username, createdAt: row.created_at.toISOString() },
      session: issue(reply, session),
    });
  });

  app.post<{ Body: { username: string } }>("/forgot-password", {
    schema: { body: { type: "object", additionalProperties: false, required: ["username"], properties: { username: { type: "string", maxLength: 64 } } } },
  }, async (req, reply) => {
    // ARCH-012 interim: reset endpoints disabled in production.
    if (isProd()) return reply.code(404).send({ error: "not_found", message: "Not found." });
    const token = await auth.createResetToken(auth.normalizeUsername(req.body.username));
    const body: Record<string, unknown> = {
      message: "If that account exists, a password reset has been initiated.",
    };
    // DEV-ONLY SHIM: no email/SMS delivery exists yet (accounts are username-only).
    // Never enable AUTH_DEV_RETURN_RESET_TOKEN in a production environment.
    if (token && !isProd() && process.env.AUTH_DEV_RETURN_RESET_TOKEN === "true") body.devResetToken = token;
    return reply.send(body);
  });

  app.post<{ Body: { token: string; newPassword: string } }>("/reset-password", {
    schema: { body: { type: "object", additionalProperties: false, required: ["token", "newPassword"],
      properties: { token: { type: "string", minLength: 20, maxLength: 128 }, newPassword: password } } },
  }, async (req, reply) => {
    if (isProd()) return reply.code(404).send({ error: "not_found", message: "Not found." });
    const ok = await auth.resetPassword(req.body.token, req.body.newPassword);
    if (!ok) return reply.code(400).send({ error: "invalid_token", message: "Reset token is invalid or expired." });
    clearSession(reply);
    return reply.send({ message: "Password updated. Please sign in again." });
  });

  app.post("/signout", async (req, reply) => {
    const t = tokenFrom(req);
    if (t) await auth.deleteSession(t);
    clearSession(reply);
    return reply.code(204).send();
  });

  // E2EE-72: delete my account. Requires the current password. Fail-CLOSED per-IP limit like signin.
  app.delete<{ Body: { password: string } }>("/me", {
    ...shared({ body: deleteAccountRequestSchema }),
    config: { rateLimit: { ...ipLimit.rateLimit, max: 10, keyGenerator: (req: FastifyRequest) => `acct-del:${clientIp(req)}` } },
  }, async (req, reply) => {
    const t = tokenFrom(req);
    const user = t ? await auth.userForSession(t) : null;
    if (!user) return reply.code(401).send({ error: "unauthenticated", message: "Not signed in." });
    const row = await auth.findUserForLogin(user.username);
    if (!row || !(await auth.verifyPassword(row.password_hash, req.body.password)))
      return reply.code(401).send({ error: "invalid_credentials", message: "Password is incorrect." });
    const refs = await tx((c) => auth.deleteAccount(c, user.id));
    // Blobs: best-effort after commit; rows are already gone so nothing can reference them.
    for (const ref of refs) {
      try { await objectStore().delete(`a/${ref}`); }
      catch (e) { req.log.error({ err: { name: (e as Error)?.name } }, "account delete: blob delete failed"); }
    }
    clearSession(reply);
    return reply.code(204).send();
  });

  app.get("/me", async (req, reply) => {
    const t = tokenFrom(req);
    const user = t ? await auth.userForSession(t) : null;
    if (!user) return reply.code(401).send({ error: "unauthenticated", message: "Not signed in." });
    return reply.send({ user });
  });
}
