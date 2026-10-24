import { expect, test } from "@playwright/test";
import { safeNext } from "../src/lib/safe-next";

// ARCH-015 unit cases (no browser needed).
const rejected = ["//evil.com", "/\\evil.com", "/%2F%2Fevil.com", "/%5Cevil.com", "https://evil.com",
  "javascript:alert(1)", "/\tevil", "/\u0000x", "", "evil.com", "/"];
for (const v of rejected) {
  test(`safeNext rejects ${JSON.stringify(v)}`, () => expect(safeNext(v)).toBe("/chat"));
}
test("safeNext accepts /settings", () => expect(safeNext("/settings")).toBe("/settings"));
test("safeNext handles null", () => expect(safeNext(null)).toBe("/chat"));
