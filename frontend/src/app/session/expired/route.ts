import { NextResponse, type NextRequest } from "next/server";

// ARCH-016: clearing the session cookie is POST-only with a same-origin check,
// so no cross-site GET (link, <img>, prefetch) can sign a user out. GET => 405.
export function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  if (origin !== req.nextUrl.origin || (site !== null && site !== "same-origin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const res = new NextResponse(null, { status: 204 });
  res.cookies.delete("e2ee_session");
  return res;
}
