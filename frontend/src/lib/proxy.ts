// Pure helpers for the /api/[...path] proxy, unit-testable without Next.js.

/** RFC 7230 hop-by-hop headers plus ones fetch/undici must set itself. */
export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/** Client-supplied headers that must never reach the backend as-is. */
export const SPOOFABLE = new Set(["x-proxy-secret", "x-forwarded-for", "x-real-ip", "forwarded"]);

function connectionListed(h: Headers): Set<string> {
  const v = h.get("connection");
  return new Set(v ? v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : []);
}

/** Real client IP: Vercel edge sets x-real-ip and the first x-forwarded-for hop. */
export function clientIp(h: Headers, fallback?: string | null): string | null {
  const real = h.get("x-real-ip")?.trim();
  if (real) return real;
  const first = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (first) return first;
  return fallback ?? null;
}

export function buildUpstreamHeaders(incoming: Headers, opts: { secret: string | null; ip: string | null }): Headers {
  const extra = connectionListed(incoming);
  const out = new Headers();
  incoming.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k) || SPOOFABLE.has(k) || extra.has(k) || k.startsWith("x-vercel-")) return;
    out.append(k, value);
  });
  if (opts.ip) out.set("x-forwarded-for", opts.ip);
  if (opts.secret) out.set("x-proxy-secret", opts.secret);
  return out;
}

export function buildDownstreamHeaders(upstream: Headers): Headers {
  const extra = connectionListed(upstream);
  const out = new Headers();
  upstream.forEach((value, key) => {
    const k = key.toLowerCase();
    // set-cookie handled separately so multiple values are preserved verbatim;
    // content-encoding dropped because fetch already decoded the body.
    if (HOP_BY_HOP.has(k) || extra.has(k) || k === "set-cookie" || k === "content-encoding") return;
    out.append(k, value);
  });
  for (const c of upstream.getSetCookie()) out.append("set-cookie", c);
  out.set("cache-control", "no-store");
  return out;
}

export function upstreamUrl(base: string, path: string[], search: string): string {
  const p = path.map(encodeURIComponent).join("/");
  return `${base}/${p}${search}`;
}

/** Every method except GET/HEAD forwards its body (DELETE /auth/me carries {password}). */
export const forwardsBody = (method: string): boolean => method !== "GET" && method !== "HEAD";
