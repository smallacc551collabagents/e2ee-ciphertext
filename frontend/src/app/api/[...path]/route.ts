import "server-only";
import type { NextRequest } from "next/server";
import { BACKEND_URL, isProduction, proxySecret } from "@/lib/backend";
import { buildDownstreamHeaders, buildUpstreamHeaders, clientIp, forwardsBody, upstreamUrl } from "@/lib/proxy";

// First-party proxy (ARCH-013 / E2EE-68): the browser only talks to /api/* on our origin, so the
// backend's httpOnly e2ee_session cookie is first-party. We inject x-proxy-secret and a trusted
// x-forwarded-for so the backend can rate-limit per real client IP.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Ctx = { params: Promise<{ path: string[] }> };

async function proxy(req: NextRequest, ctx: Ctx): Promise<Response> {
  const secret = proxySecret();
  if (!secret && isProduction()) {
    return Response.json({ error: "Proxy misconfigured" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
  const { path } = await ctx.params;
  const target = upstreamUrl(BACKEND_URL, path, req.nextUrl.search);
  const ip = clientIp(req.headers, (req as unknown as { ip?: string }).ip ?? null);
  const headers = buildUpstreamHeaders(req.headers, { secret, ip });
  const hasBody = forwardsBody(req.method);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    return Response.json({ error: "Backend unavailable" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
  const body = req.method === "HEAD" || [204, 304].includes(upstream.status) ? null : await upstream.arrayBuffer();
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: buildDownstreamHeaders(upstream.headers) });
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
