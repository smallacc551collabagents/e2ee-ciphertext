import { test, expect } from "@playwright/test";
import { mergeThread } from "../src/features/chat/mergeThread";

type R = { id: string; clientId?: string; fromMe: boolean; status: string; text: string };
const wait = (id: string): R => ({ id, fromMe: false, status: "failed", text: "Waiting for this message’s key from the sender…" });
const ok = (id: string, clientId: string): R => ({ id, clientId, fromMe: false, status: "delivered", text: "plain-" + id });

test("late group keys: placeholders are replaced in place, no duplicates, order kept", () => {
  const screen = [ok("m0", "c0"), wait("m1"), wait("m2"), wait("m3"), wait("m4")];
  const fresh = [screen[0]!, ok("m1", "c1"), ok("m2", "c2"), ok("m3", "c3"), ok("m4", "c4")];
  const out = mergeThread(screen, fresh);
  expect(out.map((m) => m.id)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  expect(out.some((m) => m.text.startsWith("Waiting"))).toBe(false);
});

test("optimistic own sends are kept until the server lists them, then deduped by clientId", () => {
  const mine: R = { id: "tmp-1", clientId: "c9", fromMe: true, status: "sending", text: "hi" };
  const a = mergeThread([ok("m0", "c0"), mine], [ok("m0", "c0")]);
  expect(a.map((m) => m.id)).toEqual(["m0", "tmp-1"]);
  const b = mergeThread(a, [ok("m0", "c0"), { id: "m5", clientId: "c9", fromMe: true, status: "sent", text: "hi" }]);
  expect(b.map((m) => m.id)).toEqual(["m0", "m5"]);
});

test("no change -> same array (no re-render)", () => {
  const rows = [ok("m0", "c0")];
  expect(mergeThread(rows, [rows[0]!])).toBe(rows);
});
