import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

/** Constant-time check of the x-proxy-secret header against PROXY_SHARED_SECRET.
 *  If the env var is unset/empty, the forwarded IP is NEVER trusted. */
export function hasValidProxySecret(req: FastifyRequest): boolean {
  const expected = process.env.PROXY_SHARED_SECRET;
  if (!expected) return false;
  const got = req.headers["x-proxy-secret"];
  if (typeof got !== "string" || got.length === 0) return false;
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Length guard: timingSafeEqual throws on length mismatch. Compare against
  // itself to keep timing roughly uniform, then fail.
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Real client IP for rate limiting.
 *  Only when the request carries a valid x-proxy-secret do we read x-forwarded-for.
 *  Our frontend proxy (/api/[...path]) OVERWRITES x-forwarded-for with the single real
 *  client IP, so we take the FIRST (leftmost) entry. Otherwise: socket remote address. */
export function clientIp(req: FastifyRequest): string {
  if (hasValidProxySecret(req)) {
    const xff = req.headers["x-forwarded-for"];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    const first = raw?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}
