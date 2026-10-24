import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

const sha256 = (v: string): Buffer => createHash("sha256").update(v, "utf8").digest();

/** Constant-time check of the x-proxy-secret header against PROXY_SHARED_SECRET.
 *  Both sides are SHA-256 hashed first, so timingSafeEqual always compares two
 *  32-byte digests: no length pre-check, and the secret's length is not leaked.
 *  If the env var is unset/empty, the forwarded IP is NEVER trusted. */
export function hasValidProxySecret(req: FastifyRequest): boolean {
  const expected = process.env.PROXY_SHARED_SECRET;
  if (!expected) return false;
  const got = req.headers["x-proxy-secret"];
  if (typeof got !== "string" || got.length === 0) return false;
  return timingSafeEqual(sha256(got), sha256(expected));
}

const firstHeader = (v: string | string[] | undefined): string | undefined => {
  const raw = Array.isArray(v) ? v[0] : v;
  const first = raw?.split(",")[0]?.trim();
  return first || undefined;
};

/** Real client IP for rate limiting (ARCH-019).
 *  1. Valid x-proxy-secret: trust x-forwarded-for (our /api/[...path] proxy OVERWRITES it
 *     with the single real client IP, so take the leftmost entry).
 *  2. Otherwise NEVER read the client-spoofable x-forwarded-for. Use Vercel's edge-set
 *     x-real-ip, then x-vercel-forwarded-for, and only then the socket address (on Vercel
 *     the socket is Vercel infra, which would put every client in one bucket). */
export function clientIp(req: FastifyRequest): string {
  if (hasValidProxySecret(req)) {
    const fwd = firstHeader(req.headers["x-forwarded-for"]);
    if (fwd) return fwd;
  }
  return (
    firstHeader(req.headers["x-real-ip"]) ??
    firstHeader(req.headers["x-vercel-forwarded-for"]) ??
    req.socket.remoteAddress ??
    "unknown"
  );
}
