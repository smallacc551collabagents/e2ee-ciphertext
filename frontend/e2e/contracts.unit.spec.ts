import { expect, test } from "@playwright/test";
import * as w from "@e2ee/shared";
import { chatApi } from "../src/features/chat/data/http";
import { USERNAME_PATTERN as uiPattern } from "../src/features/chat/newChat";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const key = { publicKey: "AAAA", version: 1 };

test("responses tolerate fields the backend adds later (stripped, not rejected)", () => {
  const conv = { id: id(1), kind: "direct", members: [{ id: "u", username: "bob", extra: 1 }], newField: true };
  expect(w.createConversationResponseSchema.safeParse({ conversation: conv, meta: {} }).success).toBe(true);
  expect(w.conversationListSchema.safeParse({ conversations: [conv], total: 1 }).success).toBe(true);
  const msg = { id: id(2), conversationId: id(1), senderId: "u", seq: "1", clientMsgId: "cid_12345", ciphertext: "AAAA", version: 1, createdAt: "x", deliveredAt: null };
  expect(w.messagePageSchema.safeParse({ messages: [msg], nextCursor: null, hasMore: false, extra: 1 }).success).toBe(true);
  expect(w.sendMessageResponseSchema.safeParse({ message: msg, duplicate: false, x: 1 }).success).toBe(true);
  expect(w.ackResponseSchema.safeParse({ acked: 1, x: 1 }).success).toBe(true);
  expect(w.prekeyCountSchema.safeParse({ oneTimePrekeyCount: 3, x: 1 }).success).toBe(true);
  const bundle = { userId: "u", username: "bob", identityKey: { ...key, alg: "x" }, signedPrekey: { keyId: 1, ...key, signature: "AAAA", createdAt: "x" }, oneTimePrekey: { keyId: 2, ...key, x: 1 }, extra: 1 };
  expect(w.prekeyBundleSchema.safeParse(bundle).success).toBe(true);
});

test("client-built requests pass the strict request schemas", () => {
  expect(w.createConversationRequestSchema.safeParse({ username: "bob.smith" }).success).toBe(true);
  expect(w.sendMessageRequestSchema.safeParse({ clientMsgId: "cid_12345678", ciphertext: "AAAA", version: 1 }).success).toBe(true);
  expect(w.sendMessageRequestSchema.safeParse({ clientMsgId: "cid_12345678", ciphertext: "", version: 1 }).success).toBe(false);
  expect(w.ackRequestSchema.safeParse({ messageIds: [] }).success).toBe(false);
  expect(w.publishKeysRequestSchema.safeParse({ oneTimePrekeys: [{ keyId: 1, ...key }] }).success).toBe(true);
  expect(w.publishKeysRequestSchema.safeParse({ identityKey: { ...key, extra: 1 } }).success).toBe(false);
});

test("ack never sends an empty list; dedupes and chunks at 500", async () => {
  const bodies: { messageIds: string[] }[] = [];
  const g = globalThis as Record<string, unknown>; const orig = g.fetch;
  g.fetch = async (_u: string, init: RequestInit) => { const b = JSON.parse(String(init.body)); bodies.push(b); return new Response(JSON.stringify({ acked: b.messageIds.length })); };
  try {
    expect(await chatApi.ack([])).toEqual({ acked: 0 });
    expect(bodies).toHaveLength(0);
    const ids = Array.from({ length: 501 }, (_, i) => id(i));
    expect(await chatApi.ack([...ids, ids[0]!])).toEqual({ acked: 501 });
    expect(bodies.map((b) => b.messageIds.length)).toEqual([500, 1]);
  } finally { g.fetch = orig; }
});

test("New chat username validation uses the shared pattern", () => {
  expect(uiPattern).toBe(w.USERNAME_PATTERN);
});
