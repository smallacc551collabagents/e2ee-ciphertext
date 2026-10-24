import { expect, test } from "@playwright/test";
import { buildDownstreamHeaders, buildUpstreamHeaders, clientIp, upstreamUrl } from "../src/lib/proxy";
import { backendAuthHeaders } from "../src/lib/backend";

// Pure unit tests for the /api proxy helpers (no browser, no network).
test.describe("proxy helpers (unit)", () => {
  test("strips client x-proxy-secret / x-forwarded-for / hop-by-hop, injects ours", () => {
    const inc = new Headers({
      "x-proxy-secret": "attacker",
      "x-forwarded-for": "6.6.6.6, 10.0.0.1",
      "x-real-ip": "1.2.3.4",
      forwarded: "for=6.6.6.6",
      connection: "keep-alive, x-custom-hop",
      "x-custom-hop": "1",
      "keep-alive": "timeout=5",
      "transfer-encoding": "chunked",
      upgrade: "websocket",
      host: "evil.example",
      "content-type": "application/json",
      cookie: "e2ee_session=abc",
    });
    const out = buildUpstreamHeaders(inc, { secret: "s3cret", ip: clientIp(inc) });
    expect(out.get("x-proxy-secret")).toBe("s3cret");
    expect(out.get("x-forwarded-for")).toBe("1.2.3.4");
    for (const h of ["forwarded", "x-real-ip", "connection", "x-custom-hop", "keep-alive", "transfer-encoding", "upgrade", "host"]) {
      expect(out.has(h), h).toBe(false);
    }
    expect(out.get("content-type")).toBe("application/json");
    expect(out.get("cookie")).toBe("e2ee_session=abc");
  });

  test("no secret configured -> no x-proxy-secret forwarded (client value never leaks through)", () => {
    const out = buildUpstreamHeaders(new Headers({ "x-proxy-secret": "attacker" }), { secret: null, ip: null });
    expect(out.has("x-proxy-secret")).toBe(false);
    expect(out.has("x-forwarded-for")).toBe(false);
  });

  test("client IP precedence: x-real-ip, then first x-forwarded-for hop, then fallback", () => {
    expect(clientIp(new Headers({ "x-real-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" }))).toBe("1.1.1.1");
    expect(clientIp(new Headers({ "x-forwarded-for": " 2.2.2.2 , 3.3.3.3" }))).toBe("2.2.2.2");
    expect(clientIp(new Headers(), "9.9.9.9")).toBe("9.9.9.9");
  });

  test("multiple Set-Cookie headers pass through unchanged; hop-by-hop dropped; no-store", () => {
    const up = new Headers();
    up.append("set-cookie", "e2ee_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax");
    up.append("set-cookie", "other=1; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT");
    up.set("content-type", "application/json");
    up.set("transfer-encoding", "chunked");
    up.set("connection", "close");
    up.set("content-encoding", "gzip");
    const out = buildDownstreamHeaders(up);
    expect(out.getSetCookie()).toEqual([
      "e2ee_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax",
      "other=1; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT",
    ]);
    expect(out.get("content-type")).toBe("application/json");
    expect(out.has("transfer-encoding")).toBe(false);
    expect(out.has("connection")).toBe(false);
    expect(out.has("content-encoding")).toBe(false);
    expect(out.get("cache-control")).toBe("no-store");
  });

  test("upstream URL strips /api and keeps query", () => {
    expect(upstreamUrl("https://b.example", ["auth", "me"], "?a=1&b=2")).toBe("https://b.example/auth/me?a=1&b=2");
  });
});

test.describe("backendAuthHeaders (ARCH-022, unit)", () => {
  test("server-side /auth/me calls carry the real client IP and our secret only", () => {
    process.env.PROXY_SHARED_SECRET = "s3cret";
    const h = backendAuthHeaders(new Headers({ "x-real-ip": "1.2.3.4", "x-forwarded-for": "6.6.6.6", "x-proxy-secret": "attacker" }));
    expect(h).toEqual({ "x-proxy-secret": "s3cret", "x-forwarded-for": "1.2.3.4" });
    expect(backendAuthHeaders(new Headers({ "x-forwarded-for": "2.2.2.2, 3.3.3.3" }))["x-forwarded-for"]).toBe("2.2.2.2");
    expect(backendAuthHeaders(new Headers(), "9.9.9.9")["x-forwarded-for"]).toBe("9.9.9.9");
    expect("x-forwarded-for" in backendAuthHeaders(new Headers())).toBe(false);
    delete process.env.PROXY_SHARED_SECRET;
    expect(backendAuthHeaders(new Headers())).toEqual({});
  });
});
