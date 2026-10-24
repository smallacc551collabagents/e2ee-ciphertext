import { expect, test } from "@playwright/test";
import * as c from "@e2ee/crypto";
import { AttachmentError, decodeAttachmentMessage, encodeAttachmentMessage, maxCiphertext, openAttachment, sendAttachment, STORAGE_ORIGIN, type Deps } from "../src/features/chat/attachments/flow";

const REF = "A".repeat(43);
const CONV = "11111111-1111-4111-8111-111111111111";

function fakes(over: Partial<Deps> = {}) {
  const log: { m: string; p: string; body?: unknown }[] = [];
  const store = new Map<string, Uint8Array>();
  const d: Deps = {
    crypto: c,
    async api(m, p, body) {
      log.push({ m, p, body });
      if (p === "/attachments/upload-url") return { ref: REF, upload: { url: `${STORAGE_ORIGIN}/e2ee-attachments`, fields: { key: `a/${REF}`, policy: "p", "x-amz-signature": "s" } }, expiresAt: "x", maxBytes: 26_220_824 };
      if (p.endsWith("/complete")) return { ref: REF, status: "stored" };
      if (p.endsWith("/download-url")) return { downloadUrl: `${STORAGE_ORIGIN}/e2ee-attachments/a/${REF}?sig=1` };
      throw { status: 500 };
    },
    async postForm(url, form, onP) {
      const entries = [...form.entries()];
      log.push({ m: "STORAGE_POST", p: url, body: entries.map(([k]) => k) });
      store.set(REF, new Uint8Array(await (entries.at(-1)![1] as Blob).arrayBuffer()));
      onP(1);
      return 204;
    },
    async getBytes() { log.push({ m: "STORAGE_GET", p: REF }); const b = store.get(REF); return b ? { status: 200, bytes: b } : { status: 404 }; },
    ...over,
  };
  return { d, log, store };
}

test("send: encrypt -> upload-url {conversationId,size,sha256} -> multipart (file last) -> complete; nothing sensitive to server", async () => {
  const { d, log, store } = fakes();
  const data = new TextEncoder().encode("secret file body");
  const desc = await sendAttachment(CONV, data, { name: "notes.txt", mime: "text/plain" }, d);
  expect(log.map((l) => `${l.m} ${l.p}`)).toEqual([
    "POST /attachments/upload-url", `STORAGE_POST ${STORAGE_ORIGIN}/e2ee-attachments`, `POST /attachments/${REF}/complete`,
  ]);
  expect(Object.keys(log[0]!.body as object).sort()).toEqual(["conversationId", "sha256", "size"]);
  expect((log[0]!.body as { size: number }).size).toBe(store.get(REF)!.byteLength);
  expect(log[1]!.body).toEqual(["key", "policy", "x-amz-signature", "file"]);
  const wire = JSON.stringify(log) + new TextDecoder().decode(store.get(REF));
  for (const leak of ["secret file body", "notes.txt", "text/plain", desc.key]) expect(wire).not.toContain(leak);
  expect(desc.ref).toBe(REF);
  // round trip: descriptor only travels inside the encrypted message
  const msg = encodeAttachmentMessage(desc);
  const got = await openAttachment(decodeAttachmentMessage(msg), d);
  expect(new TextDecoder().decode(got.bytes)).toBe("secret file body");
  expect(got.descriptor.name).toBe("notes.txt");
});

test("send: rejects before any upload when over crypto max or server maxBytes", async () => {
  const { d, log } = fakes();
  await expect(sendAttachment(CONV, new Uint8Array(c.ATTACHMENT_MAX_BYTES + 1), { name: "big.bin", mime: "application/octet-stream" }, d)).rejects.toMatchObject({ code: "too_large" });
  expect(log).toEqual([]);
  const small = fakes({ async api(m, p) { small.log.push({ m, p }); return { ref: REF, upload: { url: `${STORAGE_ORIGIN}/b`, fields: {} }, expiresAt: "x", maxBytes: 10 }; } });
  await expect(sendAttachment(CONV, new Uint8Array(100), { name: "a.bin", mime: "application/octet-stream" }, small.d)).rejects.toMatchObject({ code: "too_large" });
  expect(small.log.map((l) => l.p)).toEqual(["/attachments/upload-url"]);
  expect(maxCiphertext(c)).toBe(26_220_824);
});

test("send: refuses an upload URL outside the storage origin", async () => {
  const f = fakes({ async api() { return { ref: REF, upload: { url: "https://evil.example/x", fields: {} }, expiresAt: "x", maxBytes: 26_220_824 }; } });
  await expect(sendAttachment(CONV, new Uint8Array(4), { name: "a.bin", mime: "application/octet-stream" }, f.d)).rejects.toBeInstanceOf(AttachmentError);
});

for (const [label, over] of [
  ["download-url 404", { async api() { throw { status: 404 }; } }],
  ["download-url 410", { async api() { throw { status: 410 }; } }],
  ["storage fetch 404", { async getBytes() { return { status: 404 }; } }],
  ["storage fetch 410", { async getBytes() { return { status: 410 }; } }],
] as const) {
  test(`receive: ${label} -> 'Attachment expired' (non-retryable, single attempt)`, async () => {
    const base = fakes();
    const desc = await sendAttachment(CONV, new Uint8Array([1, 2, 3]), { name: "x.bin", mime: "application/octet-stream" }, base.d);
    let calls = 0;
    const d: Deps = { ...base.d, ...(over as Partial<Deps>) };
    const wrapApi = d.api; d.api = async (...a) => { calls++; return wrapApi(...a); };
    const err = await openAttachment(desc, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachmentError);
    expect(err).toMatchObject({ code: "expired", retryable: false, message: "Attachment expired" });
    expect(calls).toBe(1); // no retry loop
  });
}

test("receive: never trusts server bytes/metadata — swapped blob or tampered descriptor fails closed", async () => {
  const { d, store } = fakes();
  const desc = await sendAttachment(CONV, new Uint8Array([9, 9, 9]), { name: "x.bin", mime: "application/octet-stream" }, d);
  const b = store.get(REF)!; b[b.length - 1]! ^= 1;
  await expect(openAttachment(desc, d)).rejects.toMatchObject({ code: "integrity" });
  await expect(openAttachment({ ...desc, name: "../../etc/passwd" }, d)).rejects.toMatchObject({ code: "integrity" });
  await expect(openAttachment({ ...desc, ref: "../x" }, d)).rejects.toMatchObject({ code: "integrity" });
});

test("message payload: only tagged JSON is treated as an attachment", () => {
  expect(decodeAttachmentMessage("hello")).toBeNull();
  expect(decodeAttachmentMessage('{"t":"other"}')).toBeNull();
  expect(decodeAttachmentMessage(encodeAttachmentMessage({ v: 1, key: "k", sha256: "s", size: 1, name: "n", mime: "a/b" }))).toMatchObject({ name: "n" });
});
