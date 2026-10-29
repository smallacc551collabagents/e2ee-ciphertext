import { assertSameAccount } from "@/lib/session-guard";
// E2EE attachments (E2EE-47) client flow. The server only ever sees opaque ciphertext,
// its size and sha256. Key, name, MIME and ref travel ONLY inside the Olm-encrypted message.
import type { AttachmentDescriptor, AttachmentMeta } from "@e2ee/crypto";
import { z } from "zod";

import { ATTACHMENT_STORAGE_ORIGIN as STORAGE_ORIGIN } from "@/lib/storage-origin";
export { STORAGE_ORIGIN };

export type Phase = "encrypting" | "uploading" | "finalizing" | "downloading" | "decrypting";
export type AttachmentErrorCode = "too_large" | "expired" | "integrity" | "network" | "server";
export class AttachmentError extends Error {
  constructor(public readonly code: AttachmentErrorCode, message: string, public readonly retryable = code === "network" || code === "server") {
    super(message);
  }
}

type CryptoAtt = {
  encryptAttachment(d: Uint8Array, m: AttachmentMeta): Promise<{ blob: Uint8Array; descriptor: AttachmentDescriptor }>;
  parseAttachmentDescriptor(x: unknown): AttachmentDescriptor;
  decryptAttachment(b: Uint8Array, d: AttachmentDescriptor): Promise<Uint8Array>;
  ATTACHMENT_MAX_BYTES: number;
  ATTACHMENT_CHUNK_BYTES: number;
};

export interface Deps {
  crypto: CryptoAtt;
  /** Same-origin JSON API (through /api proxy, cookie auth). Throws {status} on non-2xx. */
  api(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
  /** Multipart POST to presigned storage URL; reports upload progress 0..1. */
  postForm(url: string, form: FormData, onProgress: (f: number) => void): Promise<number>;
  /** GET presigned URL -> bytes. Returns status for non-2xx. */
  getBytes(url: string, onProgress: (f: number) => void): Promise<{ status: number; bytes?: Uint8Array }>;
}

/** Max ciphertext for the crypto plaintext cap: header + 16 B tag per chunk. */
export const maxCiphertext = (c: Pick<CryptoAtt, "ATTACHMENT_MAX_BYTES" | "ATTACHMENT_CHUNK_BYTES">) =>
  c.ATTACHMENT_MAX_BYTES + 24 + Math.ceil(c.ATTACHMENT_MAX_BYTES / c.ATTACHMENT_CHUNK_BYTES) * 16;

const uploadUrlSchema = z.object({
  ref: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  upload: z.object({ url: z.string().url(), fields: z.record(z.string(), z.string()) }),
  expiresAt: z.string(),
  maxBytes: z.number().int().positive(),
});

const status = (e: unknown) => (e as { status?: number })?.status ?? 0;
const mapErr = (e: unknown, where: string): AttachmentError => {
  if (e instanceof AttachmentError) return e;
  const s = status(e);
  if (s === 404 || s === 410) return new AttachmentError("expired", "Attachment expired", false);
  if (s === 413) return new AttachmentError("too_large", "File is too large", false);
  if (s === 422) return new AttachmentError("integrity", "Upload failed an integrity check", true);
  if (s === 0) return new AttachmentError("network", `Network error during ${where}`);
  return new AttachmentError("server", `Server error during ${where} (${s})`);
};

/** Encrypt -> upload-url -> presigned POST -> complete. Returns the descriptor (with ref) to put INSIDE the encrypted message. */
export async function sendAttachment(
  conversationId: string, data: Uint8Array, meta: AttachmentMeta, d: Deps, onPhase: (p: Phase, f?: number) => void = () => {},
): Promise<AttachmentDescriptor> {
  if (data.byteLength > d.crypto.ATTACHMENT_MAX_BYTES) throw new AttachmentError("too_large", "File is larger than 25 MiB", false);
  onPhase("encrypting");
  const { blob, descriptor } = await d.crypto.encryptAttachment(data, meta);
  if (blob.byteLength > maxCiphertext(d.crypto)) throw new AttachmentError("too_large", "Encrypted file exceeds the limit", false);
  let up: z.infer<typeof uploadUrlSchema>;
  try {
    const parsed = uploadUrlSchema.safeParse(await d.api("POST", "/attachments/upload-url", { conversationId, size: blob.byteLength, sha256: descriptor.sha256 }));
    if (!parsed.success) throw new AttachmentError("server", "Unexpected upload response");
    up = parsed.data;
  } catch (e) { throw mapErr(e, "upload"); }
  if (blob.byteLength > up.maxBytes) throw new AttachmentError("too_large", "Encrypted file exceeds the server limit", false);
  if (new URL(up.upload.url).origin !== STORAGE_ORIGIN) throw new AttachmentError("server", "Unexpected upload host");
  const form = new FormData();
  for (const [k, v] of Object.entries(up.upload.fields)) form.append(k, v);
  form.append("file", new Blob([blob as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" })); // must be last
  onPhase("uploading", 0);
  let st: number;
  try { st = await d.postForm(up.upload.url, form, (f) => onPhase("uploading", f)); } catch (e) { throw mapErr(e, "upload"); }
  if (st < 200 || st >= 300) throw mapErr({ status: st === 403 || st === 400 ? 502 : st }, "upload");
  onPhase("finalizing");
  try { await d.api("POST", `/attachments/${encodeURIComponent(up.ref)}/complete`); } catch (e) { throw mapErr(e, "finalize"); }
  return { ...descriptor, ref: up.ref };
}

/** download-url -> fetch -> verify+decrypt locally. Descriptor comes from the decrypted message and is re-validated; server metadata is never trusted. */
export async function openAttachment(untrusted: unknown, d: Deps, onPhase: (p: Phase, f?: number) => void = () => {}): Promise<{ descriptor: AttachmentDescriptor; bytes: Uint8Array }> {
  let desc: AttachmentDescriptor;
  try { desc = d.crypto.parseAttachmentDescriptor(untrusted); } catch { throw new AttachmentError("integrity", "Invalid attachment", false); }
  if (!desc.ref || !/^[A-Za-z0-9_-]{43}$/.test(desc.ref)) throw new AttachmentError("integrity", "Invalid attachment", false);
  onPhase("downloading", 0);
  let url: string;
  try {
    const r = z.object({ downloadUrl: z.string().url() }).safeParse(await d.api("GET", `/attachments/${encodeURIComponent(desc.ref)}/download-url`));
    if (!r.success) throw new AttachmentError("server", "Unexpected download response");
    url = r.data.downloadUrl;
  } catch (e) { throw mapErr(e, "download"); }
  if (new URL(url).origin !== STORAGE_ORIGIN) throw new AttachmentError("server", "Unexpected download host");
  let res: { status: number; bytes?: Uint8Array };
  try { res = await d.getBytes(url, (f) => onPhase("downloading", f)); } catch (e) { throw mapErr(e, "download"); }
  if (res.status < 200 || res.status >= 300 || !res.bytes) throw mapErr({ status: res.status }, "download");
  onPhase("decrypting");
  try { return { descriptor: desc, bytes: await d.crypto.decryptAttachment(res.bytes, desc) }; }
  catch { throw new AttachmentError("integrity", "Attachment failed verification", false); }
}

/** Plaintext body of an attachment chat message (encrypted as a whole by Olm). */
const TAG = "e2ee.attachment.v1";
export const encodeAttachmentMessage = (desc: AttachmentDescriptor) => JSON.stringify({ t: TAG, a: desc });
export function decodeAttachmentMessage(plaintext: string): unknown | null {
  if (!plaintext.startsWith('{"t":"' + TAG)) return null;
  try { const o = JSON.parse(plaintext) as { t?: unknown; a?: unknown }; return o.t === TAG ? o.a ?? null : null; } catch { return null; }
}

/** Browser deps: /api proxy + XHR for progress. */
export function browserDeps(crypto: CryptoAtt): Deps {
  return {
    crypto,
    async api(method, path, body) {
      assertSameAccount();
      let res: Response;
      try {
        res = await fetch(`/api${path}`, { method, credentials: "same-origin", cache: "no-store", headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? null : JSON.stringify(body) });
      } catch { throw { status: 0 }; }
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw { status: res.status };
      return json;
    },
    postForm: (url, form, onProgress) => new Promise((resolve, reject) => {
      assertSameAccount();
      const x = new XMLHttpRequest();
      x.open("POST", url);
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = () => resolve(x.status);
      x.onerror = () => reject({ status: 0 });
      x.send(form);
    }),
    getBytes: (url, onProgress) => new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("GET", url);
      x.responseType = "arraybuffer";
      x.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = () => resolve(x.status >= 200 && x.status < 300 ? { status: x.status, bytes: new Uint8Array(x.response as ArrayBuffer) } : { status: x.status });
      x.onerror = () => reject({ status: 0 });
      x.send();
    }),
  };
}
