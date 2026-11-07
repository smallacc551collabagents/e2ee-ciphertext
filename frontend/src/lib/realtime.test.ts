import { describe, expect, it } from "vitest";
import { createSyncWaitStream, deliveredIds } from "./realtime";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("sync/wait cursor", () => {
  it("adopts a v3 cursor from an old one and does not hot-loop", async () => {
    let v2 = 0, v3 = 0;
    const fetchFn = (async (url: string) => {
      const since = new URL(url, "http://localhost").searchParams.get("since");
      if (!since) return json({ changed: true, cursor: "v2.1.0.0.0.0.0.0", conversations: ["g"], toDevice: false });
      if (since.startsWith("v2.")) {
        v2++;
        return json({ changed: true, cursor: "v3.1.0.0.0.0.0.0.9", conversations: [], toDevice: false, delivered: ["g"] });
      }
      v3++;
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const events: (string | undefined)[] = [];
    const stop = createSyncWaitStream({ fetchFn, minRepeatMs: 20, maxBackoffMs: 50 }).subscribe((id) => events.push(id), () => undefined);
    await wait(200);
    stop();
    expect(v2).toBe(1);
    expect(v3).toBe(1);
    expect(events).toEqual(["g", "g"]); // bootstrap conversation, then the delivered wake
  });

  it("treats a missing or null delivered list as []", () => {
    expect(deliveredIds(undefined)).toEqual([]);
    expect(deliveredIds(null)).toEqual([]);
    expect(deliveredIds(["a", 1, "b"])).toEqual(["a", "b"]);
  });

  it("backs off when the same immediate wake repeats", async () => {
    let n = 0;
    const fetchFn = (async () => {
      n++;
      return json({ changed: true, cursor: "v3.1.0.0.0.0.0.0.5", conversations: ["g"], toDevice: false });
    }) as unknown as typeof fetch;
    const stop = createSyncWaitStream({ fetchFn, minRepeatMs: 80, maxBackoffMs: 200 }).subscribe(() => undefined, () => undefined);
    await wait(250);
    stop();
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThan(8);
  });
});
