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
  const names = ["e2ee-u1", "e2ee-u1-wrap", "e2ee-u1-plaintext", "other-app"];
  await page.evaluate(async (ns) => {
    for (const n of ns) await new Promise((r) => { const q = indexedDB.open(n); q.onsuccess = () => { q.result.close(); r(null); }; });
    localStorage.setItem("e2ee.deviceId.u1", "DEV");
  }, names);
  await page.getByRole("button", { name: /sign out|log out/i }).last().click();
  await expect(page).toHaveURL(/\/login/);
  const left = await page.evaluate(async () => ({ dbs: (await indexedDB.databases()).map((d) => d.name), dev: localStorage.getItem("e2ee.deviceId.u1") }));
  expect(left.dbs).toEqual(["other-app"]); // crypto store + -wrap + caches deleted
  expect(left.dev).toBeNull();
});
