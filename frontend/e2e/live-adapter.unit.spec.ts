import { expect, test } from "@playwright/test";
import { olmOptions } from "../src/features/chat/data/live";

test("live adapter always passes identityGate to createOlmAdapter", () => {
  const gate = { assertUserNotPending: async () => {}, assertTrusted: async () => {} };
  const store = { get: async () => undefined, set: async () => {} };
  const c = { userIdFor: (u: string) => `@${u}:e2ee.local`, createBackendTransport: () => ({ send: async () => ({}) }) as never, createIdentityGate: () => gate };
  const opts = olmOptions(c, { id: "1", username: "alice" }, "DEV1", store);
  expect(opts.identityGate).toBe(gate);
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
    receive: async (m) => (m.id === "3" ? ({ ok: false } as never) : ({ ok: true, plaintext: `t${m.id}` } as never)),
    history: {
      get: async () => undefined,
      set: async (id) => { await new Promise((r) => setTimeout(r, 10)); if (id === "2") throw new Error("disk"); log.push(`persist:${id}`); },
    },
    ack: async (ids) => { log.push(`ack:${ids.join(",")}`); },
    onView: () => {},
  });
  expect(log).toEqual(["persist:1", "ack:1"]);
});
