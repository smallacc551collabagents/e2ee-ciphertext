import { expect, test } from "@playwright/test";

// P0: a tab bound to account X must never send after the browser's session switched to Y.
const store = new Map<string, string>();
const replaced: string[] = [];
const listeners: ((e: { key: string; newValue: string | null }) => void)[] = [];
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
  window: { location: { replace: (p: string) => void replaced.push(p) }, addEventListener: (_: string, f: never) => void listeners.push(f), removeEventListener: () => undefined },
});

test("send is refused and the tab resets once another tab signs in as someone else", async () => {
  const g = await import("../src/lib/session-guard");
  const unbind = g.bindTab("user-x");
  expect(() => g.assertSameAccount()).not.toThrow();
  g.setActiveUser("user-y"); // other tab signed in as Y
  expect(() => g.assertSameAccount()).toThrow(g.SessionChangedError);
  expect(replaced).toContain("/login");
  unbind();
});
test("logout in another tab (empty active user) also blocks", async () => {
  const g = await import("../src/lib/session-guard");
  g.bindTab("user-x"); g.setActiveUser("");
  expect(() => g.assertSameAccount()).toThrow();
});
test("storage event from another tab triggers a hard reset", async () => {
  const g = await import("../src/lib/session-guard");
  replaced.length = 0; listeners.length = 0;
  g.bindTab("user-x");
  listeners.forEach((f) => f({ key: "e2ee.activeUser", newValue: "user-y" }));
  expect(replaced).toEqual(["/login"]);
});
