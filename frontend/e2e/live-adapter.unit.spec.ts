import { expect, test } from "@playwright/test";
import { olmOptions } from "../src/features/chat/data/live";

test("live adapter always passes identityGate to createOlmAdapter", () => {
  const gate = { assertUserNotPending: async () => {}, assertTrusted: async () => {} };
  const store = { get: async () => undefined, set: async () => {} };
  const wrapped = { ...gate };
  const c = { userIdFor: (u: string) => `@${u}:e2ee.local`, createBackendTransport: () => ({ send: async () => ({}) }) as never, createIdentityGate: () => gate, withRevocationCheck: () => wrapped };
  const opts = olmOptions(c, { id: "1", username: "alice" }, "DEV1", store);
  expect(opts.identityGate).toBeTruthy();
  expect(opts.identityGate).toBe(wrapped);
  expect(opts.userId).toBe("@alice:e2ee.local");
  expect(opts.storeName).toBe("e2ee-1");
  // Per-user store: a second account in the same browser never opens another user's store.
  expect(olmOptions(c, { id: "2", username: "alice" }, "DEV1", store).storeName).not.toBe(opts.storeName);
});

import { processIncoming } from "../src/features/chat/data/live";

test("decrypt -> persist -> ack: ack never fires before persist; failed persist/decrypt is not acked", async () => {
  const log: string[] = [];
  const msg = (id: string) => ({ id, conversationId: "c", senderId: "p", seq: id, clientMsgId: `cid_${id}xxxx`, ciphertext: "AA==", version: 1, createdAt: "2026-10-24T00:00:00Z" });
  await processIncoming([msg("1"), msg("2"), msg("3")], {
    receive: async (m) => (m.id === "3" ? ({ ok: false } as never) : ({ ok: true, plaintext: `t${m.id}`, sender: { userId: "@p:e2ee.local", deviceId: "D" } } as never)),
    display: (t) => t,
    history: {
      put: async (_c, _s, { id }) => { await new Promise((r) => setTimeout(r, 10)); if (id === "2") throw new Error("disk"); log.push(`persist:${id}`); },
    },
    ack: async (ids) => { log.push(`ack:${ids.join(",")}`); },
    onView: () => {},
  });
  expect(log).toEqual(["persist:1", "ack:1"]);
});

import { wipeLocalE2EE } from "../src/features/chat/data/wipe";
test("wipe calls crypto deleteLocalCryptoState(storeName) per user", async () => {
  const ls = new Map<string, string>([["e2ee.deviceId.u1", "D"], ["e2ee.deviceId.u2", "E"], ["other", "x"]]);
  const g = globalThis as Record<string, unknown>;
  g.localStorage = { get length() { return ls.size; }, key: (i: number) => [...ls.keys()][i] ?? null, removeItem: (k: string) => ls.delete(k) };
  g.indexedDB = { deleteDatabase: () => { const r: Record<string, () => void> = {}; queueMicrotask(() => r.onsuccess?.()); return r; } };
  const called: string[] = [];
  await wipeLocalE2EE(async (s) => { called.push(s); });
  expect(called.sort()).toEqual(["e2ee-u1", "e2ee-u2"]);
  expect([...ls.keys()]).toEqual(["other"]);
  delete g.localStorage; delete g.indexedDB;
});

import { createIdentityGate, withRevocationCheck } from "@e2ee/crypto";
test("identityGate is wrapped with withRevocationCheck (same store + http)", () => {
  const store = { get: async () => undefined, set: async () => {} };
  const http = { request: async () => ({}) };
  const calls: { inner: unknown; o: { http: unknown; store: unknown } }[] = [];
  const inner = { assertUserNotPending: async () => {}, assertTrusted: async () => {} };
  const c = {
    userIdFor: (u: string) => `@${u}:e2ee.local`, createBackendTransport: () => ({}) as never,
    createIdentityGate: () => inner,
    withRevocationCheck: ((g: unknown, o: { http: unknown; store: unknown }) => { calls.push({ inner: g, o }); return { ...inner, wrapped: true }; }) as never,
  };
  const opts = olmOptions(c, { id: "1", username: "alice" }, "DEV1", store, http);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.inner).toBe(inner);
  expect(calls[0]!.o.store).toBe(store);
  expect(calls[0]!.o.http).toBe(http);
  expect((opts.identityGate as { wrapped?: boolean }).wrapped).toBe(true);
});

test("real crypto: wrapped gate fails closed when /keys/identity is unreachable", async () => {
  const store = { get: async () => undefined, set: async () => {} };
  const http = { request: async () => { throw Object.assign(new Error("down"), { status: 503 }); } };
  const opts = olmOptions({ userIdFor: (u: string) => `@${u}:e2ee.local`, createBackendTransport: () => ({}) as never, createIdentityGate, withRevocationCheck }, { id: "1", username: "alice" }, "DEV1", store, http);
  await expect(opts.identityGate.assertTrusted({ userId: "@bob:e2ee.local", deviceId: "B", ed25519: "x", curve25519: "y" })).rejects.toMatchObject({ code: "TRANSPORT_FAILED" });
});

import { chatAdapter } from "../src/features/chat/data";
test("production path returns the real Olm-backed live adapter, never unavailableAdapter", () => {
  expect(chatAdapter({ id: "1", username: "alice" }).id).toBe("live");
});

import { plaintextView, safeFileName } from "../src/features/chat/data/live";
import { encodeAttachmentMessage } from "../src/features/chat/attachments/flow";

test("attachment messages decode on receive into an attachment view; plain text goes through display", async () => {
  const desc = { ref: "r1", name: "a.png", mime: "image/png", size: 3 };
  const pt = encodeAttachmentMessage(desc as never);
  expect(plaintextView(pt, () => "X")).toEqual({ text: "Attachment", attachment: desc });
  expect(plaintextView("hi", (t) => `[${t}]`)).toEqual({ text: "[hi]" });
  const views: unknown[] = [];
  await processIncoming([{ id: "1", conversationId: "c", senderId: "p", seq: "1", clientMsgId: "cid_1xxxx", ciphertext: "AA==", version: 1, createdAt: "2026-10-24T00:00:00Z" }], {
    receive: async () => ({ ok: true, plaintext: pt, sender: { userId: "@p:e2ee.local", deviceId: "D" } }) as never,
    display: (t) => t, history: { put: async () => {} }, ack: async () => {}, onView: (v) => views.push(v),
  });
  expect(views[0]).toMatchObject({ text: "Attachment", attachment: desc });
});

test("safeFileName strips path separators/control chars and bounds length", () => {
  expect(safeFileName("../x\\y\u0001.txt")).toBe(".._x_y_.txt");
  expect(safeFileName("")).toBe("file");
  expect(safeFileName("a".repeat(300))).toHaveLength(255);
});

test("live createConversation POSTs same-origin /api/conversations and returns the peer view", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const g = globalThis as Record<string, unknown>;
  const orig = g.fetch;
  g.fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ conversation: { id: "c9", kind: "direct", members: [{ id: "1", username: "alice" }, { id: "2", username: "bob" }] } }), { status: 201 });
  };
  try {
    const { liveAdapter } = await import("../src/features/chat/data/live");
    const v = await liveAdapter({ id: "1", username: "alice" }, { put: async () => {}, list: async () => [], lastSeq: async () => null, clear: async () => {}, close: () => {} } as never).createConversation!("@bob");
    expect(v).toMatchObject({ id: "c9", name: "bob" });
    expect(calls[0]!.url).toBe("/api/conversations");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.credentials).toBe("same-origin");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ username: "bob" });
  } finally { g.fetch = orig; }
});
