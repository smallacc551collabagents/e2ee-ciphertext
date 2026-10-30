import { test, expect } from "@playwright/test";
import { noteKeySource, withBadge } from "../src/features/chat/data/keySource";
import { coalesce } from "../src/lib/realtime";
type V = { id: string; fromMe: boolean; system?: boolean; unverifiedSender?: boolean };

test("forwarded key -> Unverified sender badge; later 'sender' clears it; own/system never badged", () => {
  const f = new Set<string>();
  expect(noteKeySource(f, "m1", "forwarded")).toBe(true);
  expect(noteKeySource(f, "m1", "forwarded")).toBe(false);
  expect(noteKeySource(f, "m2", "sender")).toBe(false);
  expect(noteKeySource(f, "m3", undefined)).toBe(false);
  const other: V = { id: "m1", fromMe: false };
  expect(withBadge(other, f).unverifiedSender).toBe(true);
  expect(withBadge<V>({ id: "m1", fromMe: true }, f).unverifiedSender).toBeUndefined();
  expect(withBadge<V>({ id: "m1", fromMe: false, system: true }, f).unverifiedSender).toBeUndefined();
  const same = { id: "m2", fromMe: false };
  expect(withBadge(same, f)).toBe(same);
  // persisted round-trip (what reload does), then the key arrives from the sender
  const g = new Set<string>(JSON.parse(JSON.stringify([...f])) as string[]);
  const badged = withBadge(other, g);
  expect(noteKeySource(g, "m1", "sender")).toBe(true);
  expect(withBadge(badged, g).unverifiedSender).toBeUndefined();
});

test("coalesce: a wake during a running fetch is not dropped, it re-runs once", async () => {
  let runs = 0; let release!: () => void;
  const job = coalesce(async () => { runs++; if (runs === 1) await new Promise<void>((r) => { release = r; }); });
  const p = job(); void job(); void job();
  expect(runs).toBe(1);
  release(); await p;
  expect(runs).toBe(2);
});
