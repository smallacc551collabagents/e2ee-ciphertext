import { NextResponse, type NextRequest } from "next/server";
import { BACKEND_URL, backendAuthHeaders } from "@/lib/backend";

const SESSION_COOKIE = "e2ee_session";
const PRIVATE = ["/chat", "/settings"];
const AUTH_PAGES = ["/login", "/signup"];
const matches = (p: string, list: string[]) => list.some((r) => p === r || p.startsWith(`${r}/`));

type SessionState = "none" | "valid" | "invalid";

async function sessionState(req: NextRequest): Promise<SessionState> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return "none";
  try {
    const res = await fetch(`${BACKEND_URL}/auth/me`, { headers: { ...backendAuthHeaders(req.headers, (req as unknown as { ip?: string }).ip ?? null), cookie: `${SESSION_COOKIE}=${token}` }, cache: "no-store" });
    if (res.ok) return "valid";
    return res.status === 401 ? "invalid" : "valid"; // transient backend errors: let the layout decide
  } catch {
    return "valid";
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

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const state = await sessionState(req);
  const clear = state === "invalid";

  if (pathname === "/") return state === "valid" ? NextResponse.redirect(new URL("/chat", req.url)) : toLogin(req, undefined, clear);
  if (matches(pathname, PRIVATE) && state !== "valid") return toLogin(req, pathname, clear);
  if (matches(pathname, AUTH_PAGES)) {
    if (state === "valid") return NextResponse.redirect(new URL("/chat", req.url));
    if (clear) {
      const res = NextResponse.next();
      res.cookies.delete(SESSION_COOKIE);
      return res;
    }
  }
  return NextResponse.next();
}

export const config = { matcher: ["/", "/chat/:path*", "/settings/:path*", "/login", "/signup"] };
