import { expect, test } from "@playwright/test";

// Through the real /api route handler against the backend. Reuses the shared test user; creates no users.
const username = process.env.E2E_USERNAME ?? "fe_test_1792812361556";
const password = process.env.E2E_PASSWORD ?? "correct-horse-battery";

test("signin via /api passes Set-Cookie through and session works; spoofed headers are harmless", async ({ request }) => {
  const res = await request.post("/api/auth/signin", {
    data: { username, password },
    headers: { "x-proxy-secret": "attacker", "x-forwarded-for": "6.6.6.6" },
  });
  expect(res.status()).toBe(200);
  const cookies = res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);
  expect(cookies.some((c) => /^e2ee_session=/.test(c) && /HttpOnly/i.test(c))).toBe(true);
  expect(res.headers()["cache-control"]).toBe("no-store");

  const me = await request.get("/api/auth/me");
  expect(me.status()).toBe(200);
  expect((await me.json()).user.username).toBe(username);

  const out = await request.post("/api/auth/signout");
  expect(out.ok()).toBe(true);
  expect((await request.get("/api/auth/me")).status()).toBe(401);
});

test("unknown status codes pass through (401 without cookie)", async ({ playwright, baseURL }) => {
  const ctx = await playwright.request.newContext({ baseURL });
  expect((await ctx.get("/api/auth/me")).status()).toBe(401);
  await ctx.dispose();
});
