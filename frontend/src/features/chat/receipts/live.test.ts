import { describe, expect, it, vi } from "vitest";
import { tickState } from "./model";
import { createLiveReceipts, heartbeatDelay, startHeartbeat, type LiveReceipts } from "./live";

const uid = (u: string) => `@${u}:e2ee.local`;
function mem() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const direct = {
  conversations: [{
    id: "c1", kind: "direct" as const,
    members: [
      { id: "me", username: "alice", deliveredSeq: "0", deliveredAt: null, presence: null },
      { id: "bob", username: "bob", deliveredSeq: "2", deliveredAt: "2026-11-07T12:00:00.000Z", presence: { online: true, lastSeenAt: "2026-11-07T12:00:00.000Z" } },
    ],
  }],
};
const group = {
  conversations: [{
    id: "g1", kind: "group" as const,
    members: [
      { id: "me", username: "alice", deliveredSeq: "0", deliveredAt: null, presence: null },
      { id: "b", username: "bob", deliveredSeq: "3", deliveredAt: "2026-11-07T12:00:00.000Z", presence: { online: false, lastSeenAt: "2026-11-07T11:00:00.000Z" } },
      { id: "c", username: "carol", deliveredSeq: "1", deliveredAt: "2026-11-07T11:00:00.000Z", presence: null },
    ],
  }],
};

function harness(body: unknown, storage = mem()): { live: LiveReceipts; calls: string[]; storage: ReturnType<typeof mem> } {
  const calls: string[] = [];
  const live = createLiveReceipts({
    me: { id: "me", username: "alice" },
    storage, heartbeat: false, userIdFor: uid,
    fetchFn: async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/conversations") return json(body);
      if (url === "/api/me/privacy" && (init?.method ?? "GET") === "GET") return json({ hideLastSeen: false });
      if (url === "/api/me/privacy" && init?.method === "PUT") return json({ hideLastSeen: JSON.parse(String(init.body)).hideLastSeen });
      return new Response("", { status: 404 });
    },
  });
  return { live, calls, storage };
}

describe("live receipts", () => {
  it("1:1 grey tick from deliveredSeq, blue from an E2EE receipt, and neither goes backwards after replay or reload", async () => {
    const storage = mem();
    const { live } = harness(direct, storage);
    live.bind({ sendReadReceipt: async () => undefined, ownMessages: () => [{ id: "m1", seq: "1" }, { id: "m3", seq: "3" }] });
    let r = await live.adapter.receipts("c1");
    expect(tickState("sent", r.recipients, r.byMessage.m1)).toBe("delivered");
    expect(tickState("sent", r.recipients, r.byMessage.m3)).toBe("sent");
    const presence = await live.adapter.presence("c1");
    expect(presence.bob).toEqual({ online: true });
    expect(presence.alice).toBeUndefined();
    live.publish([{ conversationId: "c1", fromUserId: uid("bob"), upToSeq: "3", ts: 1_700_000_000_000 }]);
    r = await live.adapter.receipts("c1");
    expect(tickState("sent", r.recipients, r.byMessage.m3)).toBe("read");
    live.publish([{ conversationId: "c1", fromUserId: uid("bob"), upToSeq: "1", ts: 1 }]); // replay
    r = await live.adapter.receipts("c1");
    expect(tickState("sent", r.recipients, r.byMessage.m3)).toBe("read");

    const stale = structuredClone(direct);
    stale.conversations[0]!.members[1]!.deliveredSeq = "0";
    const again = harness(stale, storage).live;
    again.bind({ sendReadReceipt: async () => undefined, ownMessages: () => [{ id: "m1", seq: "1" }, { id: "m3", seq: "3" }] });
    r = await again.adapter.receipts("c1");
    expect(tickState("sent", r.recipients, r.byMessage.m1)).toBe("read");
    expect(tickState("sent", r.recipients, r.byMessage.m3)).toBe("read");
    again.stop();
  });

  it("group: grey only when all other members are delivered, blue only when all have read", async () => {
    const { live } = harness(group);
    live.bind({ sendReadReceipt: async () => undefined, ownMessages: () => [{ id: "m2", seq: "2" }] });
    let r = await live.adapter.receipts("g1");
    expect(r.recipients.sort()).toEqual([uid("bob"), uid("carol")].sort());
    expect(tickState("sent", r.recipients, r.byMessage.m2)).toBe("sent");
    const caughtUp = structuredClone(group);
    caughtUp.conversations[0]!.members[2]!.deliveredSeq = "5";
    const up = harness(caughtUp).live;
    up.bind({ sendReadReceipt: async () => undefined, ownMessages: () => [{ id: "m2", seq: "2" }] });
    r = await up.adapter.receipts("g1");
    expect(tickState("sent", r.recipients, r.byMessage.m2)).toBe("delivered");
    up.publish([{ conversationId: "g1", fromUserId: uid("bob"), upToSeq: "9", ts: 5 }]);
    r = await up.adapter.receipts("g1");
    expect(tickState("sent", r.recipients, r.byMessage.m2)).toBe("delivered");
    up.publish([{ conversationId: "g1", fromUserId: uid("carol"), upToSeq: "2", ts: 6 }]);
    r = await up.adapter.receipts("g1");
    expect(tickState("sent", r.recipients, r.byMessage.m2)).toBe("read");
    expect((await up.adapter.presence("g1")).bob).toEqual({ lastSeenAt: "2026-11-07T11:00:00.000Z" });
    expect((await up.adapter.presence("g1")).carol).toBeUndefined(); // hidden
    up.stop();
  });

  it("sendRead targets every other member and skips self", async () => {
    const seen: unknown[] = [];
    const { live } = harness(group);
    live.bind({
      ownMessages: () => [],
      sendReadReceipt: async (id, seq, authors) => { seen.push({ id, seq, authors }); },
    });
    await live.adapter.sendRead("g1", 4);
    expect(seen).toEqual([{ id: "g1", seq: 4, authors: [uid("bob"), uid("carol")] }]);
    live.stop();
  });

  it("404 on conversations or privacy degrades without throwing into the UI or retrying", async () => {
    let n = 0;
    const live = createLiveReceipts({
      me: { id: "me", username: "alice" }, storage: mem(), heartbeat: false, userIdFor: uid,
      fetchFn: async (url) => { n++; return new Response("", { status: 404, headers: url ? {} : {} }); },
    });
    await expect(live.adapter.receipts("c1")).resolves.toEqual({ recipients: [], byMessage: {} });
    await expect(live.adapter.presence("c1")).resolves.toEqual({});
    const after = n;
    await live.adapter.receipts("c1");
    expect(n).toBe(after); // retired
    await expect(live.adapter.getLastSeenVisible()).rejects.toMatchObject({ status: 404 });
    const privacyCalls = n;
    await expect(live.adapter.setLastSeenVisible(false)).rejects.toMatchObject({ status: 404 });
    expect(n).toBe(privacyCalls); // no second network call
    live.stop();
  });

  it("privacy toggle reads and writes hideLastSeen", async () => {
    const { live, calls } = harness(direct);
    expect(await live.adapter.getLastSeenVisible()).toBe(true);
    await live.adapter.setLastSeenVisible(false);
    expect(calls.some((c) => c === "PUT /api/me/privacy")).toBe(true);
    live.stop();
  });
});

describe("heartbeat", () => {
  it("maps 204, 429 and 404 to a steady interval, a backoff, or stop", () => {
    expect(heartbeatDelay(204, null, 30_000)).toBe(30_000);
    expect(heartbeatDelay(429, "1", 30_000)).toBe(30_000); // never faster than the base interval
    expect(heartbeatDelay(429, "90", 30_000)).toBe(90_000);
    expect(heartbeatDelay(429, null, 30_000)).toBe(60_000);
    expect(heartbeatDelay(404, null, 30_000)).toBe("stop");
    expect(heartbeatDelay(500, null, 30_000)).toBe(60_000);
  });

  it("does not beat while hidden, waits out a 429, and stops on 404", async () => {
    vi.useFakeTimers();
    let visible = false;
    let onVis: () => void = () => undefined;
    let status = 204;
    let n = 0;
    const stop = startHeartbeat({
      baseMs: 1000,
      visible: () => visible,
      listen: (fn) => { onVis = fn; return () => undefined; },
      fetchFn: async () => { n++; return new Response(null, { status, headers: status === 429 ? { "retry-after": "0" } : {} }); },
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(n).toBe(0);
    visible = true;
    onVis();
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(n).toBe(2);
    status = 429;
    await vi.advanceTimersByTimeAsync(1000);
    expect(n).toBe(3);
    await vi.advanceTimersByTimeAsync(999);
    expect(n).toBe(3); // retry-after 0 still uses the base interval
    status = 404;
    await vi.advanceTimersByTimeAsync(1);
    expect(n).toBe(4);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(n).toBe(4);
    stop();
  });
});
