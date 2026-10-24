import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "e2ee_session";
const PRIVATE = ["/chat", "/settings"];
const AUTH_PAGES = ["/login", "/signup"];
const matches = (p: string, list: string[]) => list.some((r) => p === r || p.startsWith(`${r}/`));

// First gate (cookie presence). The (private) layout then validates the session with GET /auth/me.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  if (pathname === "/") return NextResponse.redirect(new URL(hasSession ? "/chat" : "/login", req.url));
  if (matches(pathname, PRIVATE) && !hasSession) {
    const url = new URL("/login", req.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  if (matches(pathname, AUTH_PAGES) && hasSession) return NextResponse.redirect(new URL("/chat", req.url));
  return NextResponse.next();
}

export const config = { matcher: ["/", "/chat/:path*", "/settings/:path*", "/login", "/signup"] };
