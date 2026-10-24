import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as auth from "../services/auth.js";

export const SESSION_COOKIE = "e2ee_session";

const username = { type: "string", pattern: auth.USERNAME_RE } as const;
const password = { type: "string", minLength: auth.PASSWORD_MIN, maxLength: auth.PASSWORD_MAX } as const;
const credsBody = {
  type: "object", additionalProperties: false, required: ["username", "password"],
  properties: { username, password },
} as const;

type Creds = { username: string; password: string };

function issue(reply: FastifyReply, s: { token: string; expiresAt: Date }) {
  // Frontend and API live on different *.vercel.app sites (public suffix => cross-site),
  // so the cookie must be SameSite=None; Secure. Bearer token is also returned for non-browser clients.
  reply.setCookie(SESSION_COOKIE, s.token, {
    httpOnly: true, secure: true, sameSite: "none", path: "/", expires: s.expiresAt,
  });
  return { token: s.token, expiresAt: s.expiresAt.toISOString() };
}

function tokenFrom(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  return req.cookies[SESSION_COOKIE];
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: Creds }>("/signup", { schema: { body: credsBody } }, async (req, reply) => {
    const user = await auth.createUser(auth.normalizeUsername(req.body.username), req.body.password);
    if (!user) return reply.code(409).send({ error: "username_taken", message: "Username is already taken." });
    const session = await auth.createSession(user.id);
    return reply.code(201).send({ user, session: issue(reply, session) });
  });

  app.post<{ Body: Creds }>("/signin", { schema: { body: credsBody } }, async (req, reply) => {
    const row = await auth.findUserForLogin(auth.normalizeUsername(req.body.username));
    const ok = await auth.verifyPassword(row?.password_hash, req.body.password);
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
    const token = await auth.createResetToken(auth.normalizeUsername(req.body.username));
    const body: Record<string, unknown> = {
      message: "If that account exists, a password reset has been initiated.",
    };
    // DEV-ONLY SHIM: no email/SMS delivery exists yet (accounts are username-only).
    // Never enable AUTH_DEV_RETURN_RESET_TOKEN in a production environment.
    if (token && process.env.AUTH_DEV_RETURN_RESET_TOKEN === "true") body.devResetToken = token;
    return reply.send(body);
  });

  app.post<{ Body: { token: string; newPassword: string } }>("/reset-password", {
    schema: { body: { type: "object", additionalProperties: false, required: ["token", "newPassword"],
      properties: { token: { type: "string", minLength: 20, maxLength: 128 }, newPassword: password } } },
  }, async (req, reply) => {
    const ok = await auth.resetPassword(req.body.token, req.body.newPassword);
    if (!ok) return reply.code(400).send({ error: "invalid_token", message: "Reset token is invalid or expired." });
    reply.clearCookie(SESSION_COOKIE, { path: "/", secure: true, sameSite: "none" });
    return reply.send({ message: "Password updated. Please sign in again." });
  });

  app.post("/signout", async (req, reply) => {
    const t = tokenFrom(req);
    if (t) await auth.deleteSession(t);
    reply.clearCookie(SESSION_COOKIE, { path: "/", secure: true, sameSite: "none" });
    return reply.code(204).send();
  });

  app.get("/me", async (req, reply) => {
    const t = tokenFrom(req);
    const user = t ? await auth.userForSession(t) : null;
    if (!user) return reply.code(401).send({ error: "unauthenticated", message: "Not signed in." });
    return reply.send({ user });
  });
}
