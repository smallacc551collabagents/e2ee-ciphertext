import { expect, test } from "@playwright/test";
import { forwardsBody } from "../src/lib/proxy";
import { deleteAccount } from "../src/features/account/deleteAccount";
import { changeKindLabel, identityWarning, NEW_DEVICE_COPY } from "../src/features/chat/identityCopy";
import { assertMayOpen } from "../src/features/chat/data/live";
import { NewDeviceRequiredError } from "../src/features/chat/data/types";
import { chatApi } from "../src/features/chat/data/http";

const g = globalThis as Record<string, unknown>;
async function withFetch<T>(f: (u: string, i: RequestInit) => Response | Promise<Response>, run: () => Promise<T>): Promise<T> {
  const orig = g.fetch; g.fetch = f; try { return await run(); } finally { g.fetch = orig; }
}

test("proxy forwards the request body for DELETE (and every non-GET/HEAD)", () => {
  for (const m of ["DELETE", "POST", "PUT", "PATCH"]) expect(forwardsBody(m), m).toBe(true);
  for (const m of ["GET", "HEAD"]) expect(forwardsBody(m), m).toBe(false);
});

test("delete account: DELETE /api/auth/me with {password}; wipe only on 204; errors keep data", async () => {
  const calls: { url: string; init: RequestInit }[] = []; let wiped = 0;
  const deps = (status: number) => ({ fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(null, { status }); }) as typeof fetch, wipe: async () => { wiped++; } });
  expect(await deleteAccount("pw-1", deps(204))).toEqual({ ok: true });
  expect(calls[0]!.url).toBe("/api/auth/me"); expect(calls[0]!.init.method).toBe("DELETE"); expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ password: "pw-1" });
  expect(wiped).toBe(1);
  expect(await deleteAccount("bad", deps(401))).toEqual({ ok: false, message: "Password is incorrect." });
  expect(await deleteAccount("x", deps(429))).toMatchObject({ ok: false });
  expect(await deleteAccount("", deps(204))).toMatchObject({ ok: false });
  expect(wiped).toBe(1); expect(calls).toHaveLength(3);
});

test("identity warnings never reassure; both kinds block until verified", () => {
  const nd = identityWarning("bob", "new-device"), kc = identityWarning("bob", "key-changed");
  expect(nd).toBe("bob’s security key changed (reported as a new device). Verify the safety number before continuing.");
  expect(kc).toMatch(/^Warning:.*intercept.*Verify the safety number/);
  for (const t of [nd, kc]) expect(t).not.toMatch(/safe to|nothing to worry|just|only a new/i);
  expect(changeKindLabel("new-device")).toBe("Reported as a new device"); expect(changeKindLabel(undefined)).toBeNull();
  expect(NEW_DEVICE_COPY.body).toMatch(/history from the old browser won’t carry over/);
});

test("new device: opening is refused until confirmNewDevice", () => {
  expect(() => assertMayOpen("needs-new-device-confirmation", false)).toThrow(NewDeviceRequiredError);
  expect(() => assertMayOpen("needs-new-device-confirmation", true)).not.toThrow();
  expect(() => assertMayOpen("existing", false)).not.toThrow();
});

test("send carries attachmentRefs (strict schema, max 10) and surfaces invalid_attachment_refs", async () => {
  const ref = "A".repeat(43); let sent: Record<string, unknown> = {};
  const msg = { id: "00000000-0000-4000-8000-000000000001", conversationId: "00000000-0000-4000-8000-000000000002", senderId: "u", seq: "1", clientMsgId: "cid_12345678", ciphertext: "AAAA", version: 1, createdAt: "x", deliveredAt: null };
  await withFetch(async (_u, i) => { sent = JSON.parse(String(i.body)); return new Response(JSON.stringify({ message: msg, duplicate: false })); },
    () => chatApi.sendMessage(msg.conversationId, { clientMsgId: "cid_12345678", ciphertext: "AAAA", version: 1, attachmentRefs: [ref] }));
  expect(sent.attachmentRefs).toEqual([ref]);
  expect(() => chatApi.sendMessage(msg.conversationId, { clientMsgId: "cid_12345678", ciphertext: "AAAA", version: 1, attachmentRefs: Array.from({ length: 11 }, (_, i) => ref.slice(0, 42) + String.fromCharCode(65 + i)) })).toThrow();
  const err = await withFetch(() => new Response(JSON.stringify({ error: "invalid_attachment_refs", message: "x" }), { status: 400 }),
    () => chatApi.sendMessage(msg.conversationId, { clientMsgId: "cid_12345678", ciphertext: "AAAA", version: 1, attachmentRefs: [ref] }).catch((e) => e));
  expect((err as { code: string }).code).toBe("invalid_attachment_refs");
});
