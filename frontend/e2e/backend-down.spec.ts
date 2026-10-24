import { expect, test } from "@playwright/test";

// E2EE-73 / ARCH-018. Run against a server whose BACKEND_URL is unreachable, e.g.
//   BACKEND_URL=http://127.0.0.1:9 pnpm dev -p 3100 & E2E_BACKEND_DOWN=1 E2E_BASE_URL=http://localhost:3100 pnpm e2e backend-down
test.skip(!process.env.E2E_BACKEND_DOWN, "needs a server with an unreachable BACKEND_URL");

test("backend down with a session cookie shows an error state, not a redirect loop", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "e2ee_session", value: "stale-or-valid", url: baseURL! }]);
  for (const path of ["/", "/chat", "/settings"]) {
    const res = await page.goto(path);
    expect(res?.status()).toBeLessThan(500);
    await expect(page).toHaveURL(/\/(chat|settings)$/);
    await expect(page.getByTestId("backend-unavailable")).toBeVisible();
  }
  // Auth pages still render (no bounce to /chat).
  await page.goto("/login");
  await expect(page).toHaveURL(/\/login$/);
});
