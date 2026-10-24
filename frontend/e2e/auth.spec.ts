import { expect, test } from "@playwright/test";

const shot = (n: string) => `${process.env.E2E_SHOTS ?? "test-results"}/${n}.png`;

// Runs against the live backend via the /api rewrite. Creates a real throwaway user.
test("signup -> chat, logout -> protected, login -> chat", async ({ page }) => {
  const username = `fe_test_${Date.now()}`;
  const password = "correct-horse-battery";

  await page.goto("/chat");
  await expect(page).toHaveURL(/\/login/);
  await page.screenshot({ path: shot("login") });

  await page.goto("/signup");
  await page.screenshot({ path: shot("signup") });
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByTestId("current-user")).toHaveText(`@${username}`);
  await page.screenshot({ path: shot("chat") });
  await page.goto("/settings");
  await page.screenshot({ path: shot("settings") });
  await page.goto("/chat");

  await page.goto("/login");
  await expect(page).toHaveURL(/\/chat$/); // logged-in users bounce off auth pages

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/chat");
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill("wrong-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toContainText("Invalid username or password");

  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/chat$/);
});
