import { expect, test } from "@playwright/test";

const username = process.env.E2E_USERNAME ?? "fe_test_1792812361556";
const password = process.env.E2E_PASSWORD ?? "correct-horse-battery";

test("settings: profile, placeholders, sign out", async ({ page }) => {
  await page.goto("/login?next=%2Fsettings");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId("settings-username")).toHaveText(username);
  await expect(page.getByTestId("devices-coming-soon")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Read receipts" })).toBeDisabled();
  await expect(page.getByText("00000 00000")).toHaveCount(0);
  await page.getByRole("button", { name: /sign out|log out/i }).last().click();
  await expect(page).toHaveURL(/\/login/);
});
