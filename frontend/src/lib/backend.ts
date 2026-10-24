import { clientIp } from "./proxy";

// Server-side backend config, shared by the /api proxy route handler, middleware and RSC
// session checks. Never import from client components: PROXY_SHARED_SECRET is server-only.

export const BACKEND_URL = (
  process.env.BACKEND_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "https://e2ee-backend.vercel.app"
).replace(/\/$/, "");

/** Returns the proxy secret, or null if unset. In production an unset secret is an error (fail closed). */
export function proxySecret(): string | null {
  const s = process.env.PROXY_SHARED_SECRET;
  return s && s.length > 0 ? s : null;
}

export const isProduction = () => process.env.NODE_ENV === "production";

/** Headers to authenticate a server-to-backend call (ARCH-013 / E2EE-68). */
/**
 * ARCH-022: pass the real client IP (same derivation as the /api proxy) so the backend can
 * rate-limit server-side /auth/me calls per client instead of per frontend instance.
 */
export function backendAuthHeaders(incoming?: Headers | null, fallbackIp?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  const s = proxySecret();
  if (s) out["x-proxy-secret"] = s;
  const ip = incoming ? clientIp(incoming, fallbackIp) : (fallbackIp ?? null);
  if (ip) out["x-forwarded-for"] = ip;
  return out;
}
