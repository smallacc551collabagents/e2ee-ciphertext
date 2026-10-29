import { expect, test } from "@playwright/test";

// The chat's realtime bell: fast poll while visible, instant on focus, stream events pass through,
// polling slows to a safety net while a stream is connected, and everything stops with the last listener.
const win: Record<string, (() => void)[]> = {};
const doc: Record<string, (() => void)[]> = {};
const on = (m: Record<string, (() => void)[]>) => ({
  addEventListener: (t: string, f: () => void) => void (m[t] ??= []).push(f),
  removeEventListener: (t: string, f: () => void) => void (m[t] = (m[t] ?? []).filter((x) => x !== f)),
});
Object.assign(globalThis, { window: on(win), document: { visibilityState: "visible", ...on(doc) } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("polls fast, fires on focus, stops on unsubscribe", async () => {
  const { createRealtime } = await import("../src/lib/realtime");
  const bell = createRealtime({ fastMs: 20 });
  const seen: string[] = [];
  const off = bell.subscribe((e) => seen.push(e.reason));
  await wait(70);
  expect(seen.filter((r) => r === "poll").length).toBeGreaterThanOrEqual(2);
  win.focus!.forEach((f) => f());
  expect(seen).toContain("focus");
  off();
  const n = seen.length;
  await wait(60);
  expect(seen.length).toBe(n);
  expect(win.focus ?? []).toHaveLength(0);
});

test("stream events pass through and slow the poll while connected", async () => {
  const { createRealtime } = await import("../src/lib/realtime");
  let push: (id?: string) => void = () => undefined;
  let state: (up: boolean) => void = () => undefined;
  const bell = createRealtime({ fastMs: 15, slowMs: 10_000, stream: { subscribe: (e, s) => { push = e; state = s; return () => undefined; } } });
  const seen: { reason: string; conversationId?: string }[] = [];
  bell.subscribe((e) => seen.push(e));
  state(true);
  seen.length = 0;
  await wait(60);
  expect(seen.filter((e) => e.reason === "poll")).toHaveLength(0);
  push("c1");
  expect(seen).toContainEqual({ reason: "stream", conversationId: "c1" });
  state(false);
  await wait(60);
  expect(seen.filter((e) => e.reason === "poll").length).toBeGreaterThanOrEqual(2);
  bell.stop();
});
