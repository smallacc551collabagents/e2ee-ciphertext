import { expect, test, type Page } from "@playwright/test";

// Runs against the backend via the /api rewrite. Only prod exists today, so it REUSES one
// test user (override with E2E_USERNAME / E2E_PASSWORD) instead of creating new accounts.
const username = process.env.E2E_USERNAME ?? "fe_test_1792812361556";
const password = process.env.E2E_PASSWORD ?? "correct-horse-battery";
const shot = (n: string) => `${process.env.E2E_SHOTS ?? "test-results"}/${n}.png`;
const alert = (page: Page) => page.getByRole("alert").filter({ hasText: /\S/ });

async function login(page: Page, path = "/login") {
  await page.goto(path);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("protected routes, login, logout", async ({ page }) => {
  await page.goto("/chat");
  await expect(page).toHaveURL(/\/login/);
  await page.screenshot({ path: shot("login") });

  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill("wrong-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(alert(page)).toContainText("Invalid username or password");

  await login(page);
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByTestId("current-user")).toHaveText(`@${username}`);
  await page.screenshot({ path: shot("chat") });

  await page.goto("/login");
  await expect(page).toHaveURL(/\/chat$/);

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/chat");
  await expect(page).toHaveURL(/\/login/);
});

test("signup with an existing username shows an error (no new user created)", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(alert(page)).toContainText("already taken");
});

test("ARCH-015: next=/settings honoured, open redirects fall back to /chat", async ({ page }) => {
  await login(page, "/login?next=%2Fsettings");
  await expect(page).toHaveURL(/\/settings$/);
  await page.context().clearCookies();
  for (const bad of ["//evil.com", "/\\evil.com", "/%2F%2Fevil.com", "https://evil.com"]) {
    await login(page, `/login?next=${encodeURIComponent(bad)}`);
    await expect(page).toHaveURL(/localhost:3000\/chat$/);
    await page.context().clearCookies();
  }
});

test("ARCH-016: no GET logout; cross-origin POST rejected; stale cookie cleared on redirect", async ({ page, request, baseURL }) => {
  expect((await request.get("/session/expired", { maxRedirects: 0 })).status()).toBe(405);
  expect((await request.post("/session/expired", { headers: { origin: "https://evil.com" } })).status()).toBe(403);

  await page.context().addCookies([{ name: "e2ee_session", value: "stale-invalid-token", url: baseURL! }]);
  await page.goto("/chat");
  await expect(page).toHaveURL(/\/login/);
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === "e2ee_session")).toBeUndefined();
});
