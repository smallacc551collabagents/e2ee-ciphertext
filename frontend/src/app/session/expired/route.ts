import { NextResponse, type NextRequest } from "next/server";

// Clears a stale/invalid session cookie (avoids middleware redirect loops) and goes to /login.
export function GET(req: NextRequest) {
  const res = NextResponse.redirect(new URL("/login", req.url));
  res.cookies.delete("e2ee_session");
  return res;
}
