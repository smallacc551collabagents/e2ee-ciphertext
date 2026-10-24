import { NextResponse, type NextRequest } from "next/server";
import { BACKEND_URL, backendAuthHeaders } from "@/lib/backend";

const SESSION_COOKIE = "e2ee_session";
const PRIVATE = ["/chat", "/settings"];
const AUTH_PAGES = ["/login", "/signup"];
const matches = (p: string, list: string[]) => list.some((r) => p === r || p.startsWith(`${r}/`));

// "unknown" = backend 5xx / unreachable (E2EE-73): never redirect on it, let the page render an error state.
type SessionState = "none" | "valid" | "invalid" | "unknown";

async function sessionState(req: NextRequest): Promise<SessionState> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return "none";
  try {
    const res = await fetch(`${BACKEND_URL}/auth/me`, { headers: { ...backendAuthHeaders(req.headers, (req as unknown as { ip?: string }).ip ?? null), cookie: `${SESSION_COOKIE}=${token}` }, cache: "no-store" });
    if (res.ok) return "valid";
    return res.status === 401 ? "invalid" : "unknown";
  } catch {
    return "unknown";
  }
}

function toLogin(req: NextRequest, next?: string, clear = false) {
  const url = new URL("/login", req.url);
  if (next) url.searchParams.set("next", next);
  const res = NextResponse.redirect(url);
  // ARCH-016: stale cookie is deleted in this same redirect response (no GET logout endpoint).
  if (clear) res.cookies.delete(SESSION_COOKIE);
  return res;
}

// E2EE-67: per-request nonce CSP. 'wasm-unsafe-eval' allows the crypto WASM (no JS eval).
export function buildCsp(nonce: string, dev = process.env.NODE_ENV !== "production"): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws:" : ""}`,
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

export async function middleware(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);
  const res = await route(req, csp);
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

async function route(req: NextRequest, csp: string): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const next = () => {
    const headers = new Headers(req.headers);
    headers.set("x-nonce", csp.match(/'nonce-([^']+)'/)![1]!);
    headers.set("Content-Security-Policy", csp);
    return NextResponse.next({ request: { headers } });
  };
  if (!matches(pathname, [...PRIVATE, ...AUTH_PAGES]) && pathname !== "/") return next();
  const state = await sessionState(req);
  const clear = state === "invalid";

  if (pathname === "/") return state === "valid" || state === "unknown" ? NextResponse.redirect(new URL("/chat", req.url)) : toLogin(req, undefined, clear);
  if (matches(pathname, PRIVATE) && (state === "none" || state === "invalid")) return toLogin(req, pathname, clear);
  if (matches(pathname, AUTH_PAGES)) {
    if (state === "valid") return NextResponse.redirect(new URL("/chat", req.url));
    if (clear) {
      const res = next();
      res.cookies.delete(SESSION_COOKIE);
      return res;
    }
  }
  return next();
}

export const config = {
  matcher: [{ source: "/((?!api|session|_next/static|_next/image|favicon.ico).*)", missing: [{ type: "header", key: "next-router-prefetch" }] }],
};
