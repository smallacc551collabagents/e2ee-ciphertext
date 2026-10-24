import { expect, test } from "@playwright/test";

test("E2EE-67: nonce CSP on pages, scripts carry the nonce, page hydrates", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text()); });
  const res = await page.goto("/login");
  const csp = res!.headers()["content-security-policy"]!;
  const script = csp.split("; ").find((d) => d.startsWith("script-src"))!;
  expect(script).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
  expect(script).toContain("'wasm-unsafe-eval'");
  expect(script).not.toContain("'unsafe-inline'");
  const nonce = script.match(/'nonce-([^']+)'/)![1];
  const res2 = await page.request.get("/login");
  expect(res2.headers()["content-security-policy"]).not.toContain(nonce); // fresh per request
  const inline = await page.locator("script:not([src])").count();
  expect(inline).toBeGreaterThan(0);
  await page.getByLabel("Username").fill("x"); // hydrated form is interactive
  expect(errors).toEqual([]);
});
