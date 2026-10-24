import type { FastifyReply, FastifyRequest } from "fastify";
import { userForSession, type PublicUser } from "../services/auth.js";

export const SESSION_COOKIE = "e2ee_session";

declare module "fastify" {
  interface FastifyRequest { user?: PublicUser }
}

/** Shared preHandler: resolves the httpOnly session cookie (cookie-only, no Bearer path). */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const t = req.cookies[SESSION_COOKIE];
  const user = t ? await userForSession(t) : null;
  if (!user) {
    await reply.code(401).send({ error: "unauthenticated", message: "Not signed in." });
    return;
  }
  req.user = user;
}

/** Authenticated user; only call in routes guarded by requireAuth. */
export const me = (req: FastifyRequest): PublicUser => req.user as PublicUser;
