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

test("sync/wait: bootstrap, wake, back off on an identical pending set, reset on change, stop on 404", async () => {
  const { createSyncWaitStream } = await import("../src/lib/realtime");
  const replies = [
    { changed: false, cursor: "v1.1.1.1", conversations: [], toDevice: false }, // bootstrap
    { changed: true, cursor: "v1.1.1.1", conversations: ["g"], toDevice: false },
    { changed: true, cursor: "v1.1.1.1", conversations: ["g"], toDevice: false }, // same: undecryptable, back off
    { changed: true, cursor: "v1.1.1.1", conversations: ["g", "h"], toDevice: false }, // new: reset
  ];
  const calls: number[] = []; const t0 = Date.now();
  const fetchFn = (async (url: string) => {
    calls.push(Date.now() - t0);
    expect(url).toMatch(/^\/api\/sync\/wait\?/);
    const r = replies.shift();
    return r ? new Response(JSON.stringify(r), { status: 200 }) : new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const events: (string | undefined)[] = []; const states: boolean[] = [];
  createSyncWaitStream({ fetchFn, minRepeatMs: 80, maxBackoffMs: 200 }).subscribe((id) => events.push(id), (s) => states.push(s));
  await wait(900);
  expect(events).toEqual(["g", "g", "h"]);
  expect(calls).toHaveLength(5);
  expect(calls[3]! - calls[2]!).toBeGreaterThanOrEqual(75); // backed off, no tight loop
  expect(states).toEqual([true, false]);
});

test("sync/wait stops when the session guard trips", async () => {
  const { createSyncWaitStream } = await import("../src/lib/realtime");
  let n = 0;
  const fetchFn = (async () => { n++; return new Response("{}", { status: 500 }); }) as unknown as typeof fetch;
  const guard = () => { throw Object.assign(new Error("x"), { name: "SessionChangedError" }); };
  createSyncWaitStream({ fetchFn, guard, minRepeatMs: 10 }).subscribe(() => undefined, () => undefined);
  await wait(100);
  expect(n).toBe(0);
});
