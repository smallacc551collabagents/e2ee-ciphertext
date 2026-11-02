import { describe, expect, it, vi } from "vitest";
import { formatLastSeen, readTracker, tickState } from "./model";

describe("tickState 1:1", () => {
  it("sending/failed/sent", () => {
    expect(tickState("sending", ["b"], [])).toBe("pending");
    expect(tickState("failed", ["b"], [])).toBe("failed");
    expect(tickState("sent", ["b"], undefined)).toBe("sent");
  });
  it("delivered then read", () => {
    expect(tickState("sent", ["b"], [{ userId: "b", deliveredAt: "x" }])).toBe("delivered");
    expect(tickState("sent", ["b"], [{ userId: "b", deliveredAt: "x", readAt: "y" }])).toBe("read");
    expect(tickState("sent", ["b"], [{ userId: "b", readAt: "y" }])).toBe("read");
  });
});

describe("tickState group", () => {
  const m = ["b", "c", "d"];
  it("grey double only when ALL delivered", () => {
    expect(tickState("sent", m, [{ userId: "b", deliveredAt: "x" }, { userId: "c", deliveredAt: "x" }])).toBe("sent");
    expect(tickState("sent", m, m.map((u) => ({ userId: u, deliveredAt: "x" })))).toBe("delivered");
  });
  it("blue only when ALL read", () => {
    const r = m.map((u) => ({ userId: u, deliveredAt: "x", readAt: u === "d" ? null : "y" }));
    expect(tickState("sent", m, r)).toBe("delivered");
    expect(tickState("sent", m, m.map((u) => ({ userId: u, readAt: "y" })))).toBe("read");
  });
  it("ignores receipts from non-recipients", () => {
    expect(tickState("sent", ["b"], [{ userId: "z", readAt: "y" }])).toBe("sent");
  });
});

describe("formatLastSeen", () => {
  const now = new Date(2026, 10, 2, 14, 30);
  it("hidden/unknown => null", () => {
    expect(formatLastSeen(null, now)).toBeNull();
    expect(formatLastSeen({ lastSeenAt: "bad" }, now)).toBeNull();
  });
  it("online and just now", () => {
    expect(formatLastSeen({ online: true }, now)).toBe("online");
    expect(formatLastSeen({ lastSeenAt: new Date(now.getTime() - 30_000).toISOString() }, now)).toBe("last seen just now");
  });
  it("today / yesterday / date", () => {
    expect(formatLastSeen({ lastSeenAt: new Date(2026, 10, 2, 14, 10).toISOString() }, now, "en-US")).toBe("last seen today at 2:10 PM");
    expect(formatLastSeen({ lastSeenAt: new Date(2026, 10, 1, 23, 5).toISOString() }, now, "en-US")).toBe("last seen yesterday at 11:05 PM");
    expect(formatLastSeen({ lastSeenAt: new Date(2026, 9, 20, 9, 0).toISOString() }, now, "en-US")).toBe("last seen 10/20/2026");
  });
});

describe("readTracker", () => {
  it("debounces and only sends increasing seqs", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const t = readTracker(send, 100);
    t.seen(3); t.seen(5); t.seen(4);
    vi.advanceTimersByTime(100);
    t.seen(5); vi.advanceTimersByTime(100);
    expect(send.mock.calls).toEqual([[5]]);
    vi.useRealTimers();
  });
});

import { foldReadReceipts, mergeReads } from "./model";
describe("read receipts (E2EE, monotonic)", () => {
  it("ignores older/equal upToSeq per fromUserId", () => {
    let m = foldReadReceipts({}, [{ conversationId: "c", fromUserId: "b", upToSeq: 5, ts: 1 }]);
    const same = foldReadReceipts(m, [{ conversationId: "c", fromUserId: "b", upToSeq: 3, ts: 2 }, { conversationId: "c", fromUserId: "b", upToSeq: 5, ts: 2 }]);
    expect(same).toBe(m);
    m = foldReadReceipts(m, [{ conversationId: "c", fromUserId: "b", upToSeq: 7, ts: 3 }]);
    expect(m.c!.b!.upToSeq).toBe(7);
  });
  it("group goes blue only when every member's upToSeq covers the message", () => {
    const marks = foldReadReceipts({}, [{ conversationId: "g", fromUserId: "b", upToSeq: 10, ts: 1 }, { conversationId: "g", fromUserId: "c", upToSeq: 4, ts: 1 }]).g;
    const base = [{ userId: "b", deliveredAt: "x" }, { userId: "c", deliveredAt: "x" }];
    expect(tickState("sent", ["b", "c"], mergeReads(base, ["b", "c"], marks, 5))).toBe("delivered");
    expect(tickState("sent", ["b", "c"], mergeReads(base, ["b", "c"], marks, 4))).toBe("read");
  });
});
