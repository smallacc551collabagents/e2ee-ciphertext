/**
 * Encrypted attachments (E2EE-47). Format: docs/crypto-attachments.md.
 *
 * WebCrypto AES-256-GCM only (no custom primitives). Each file gets a fresh random
 * 256-bit key that travels ONLY inside the Olm-encrypted message (AttachmentDescriptor);
 * the server stores an opaque blob. The blob is split into fixed-size chunks; every chunk's
 * AAD binds the blob header, its index and a final-chunk flag, so reordering, truncation,
 * extension, header edits and cross-file splicing all fail authentication.
 */
import { CryptoError } from './contract.js';

export const ATTACHMENT_VERSION = 1;
/** Plaintext bytes per chunk. */
export const ATTACHMENT_CHUNK_BYTES = 64 * 1024;
/** Product limit for one file (decision recorded in docs/crypto-attachments.md). */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const TAG = 16;
const HEADER_BYTES = 24; // magic(4) ver(1) rsvd(3) chunkSize(4) chunkCount(4) noncePrefix(8)
const MAGIC = [0x45, 0x32, 0x41, 0x31]; // "E2A1"
const MAX_NAME = 255;
const MAX_MIME = 127;

/** Goes inside the encrypted chat message, never to the server in clear. */
export interface AttachmentDescriptor {
  readonly v: 1;
  /** Server-side blob id/URL path returned by the upload; the client fills it after upload. */
  readonly ref?: string;
  /** base64 raw AES-256 key. */
  readonly key: string;
  /** base64 SHA-256 of the whole encrypted blob (verify download before decrypt). */
  readonly sha256: string;
  readonly size: number;
  readonly name: string;
  readonly mime: string;
}

export interface AttachmentMeta { readonly name: string; readonly mime: string }

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new CryptoError('UNSUPPORTED_ENVIRONMENT', 'WebCrypto is not available');
  return s;
};
const b64 = (u: Uint8Array) => { let s = ''; for (const c of u) s += String.fromCharCode(c); return btoa(s); };
const unb64 = (s: string) => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new CryptoError('INVALID_ENVELOPE', 'Invalid base64');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
const bad = (m: string) => new CryptoError('INVALID_ENVELOPE', m);

function header(chunkSize: number, chunkCount: number, prefix: Uint8Array): Uint8Array<ArrayBuffer> {
  const h = new Uint8Array(HEADER_BYTES);
  h.set(MAGIC, 0); h[4] = ATTACHMENT_VERSION;
  const dv = new DataView(h.buffer);
  dv.setUint32(8, chunkSize); dv.setUint32(12, chunkCount);
  h.set(prefix, 16);
  return h;
}
function nonce(prefix: Uint8Array, i: number): Uint8Array<ArrayBuffer> {
  const n = new Uint8Array(12); n.set(prefix, 0); new DataView(n.buffer).setUint32(8, i); return n;
}
function aad(h: Uint8Array, i: number, final: boolean): Uint8Array<ArrayBuffer> {
  const a = new Uint8Array(h.length + 5); a.set(h, 0);
  const dv = new DataView(a.buffer); dv.setUint32(h.length, i); a[h.length + 4] = final ? 1 : 0;
  return a;
}
function checkMeta(m: AttachmentMeta) {
  if (typeof m.name !== 'string' || !m.name || m.name.length > MAX_NAME || /[\u0000-\u001f/\\]/.test(m.name)) throw bad('Invalid file name');
  if (typeof m.mime !== 'string' || m.mime.length > MAX_MIME || !/^[\w.+-]+\/[\w.+-]+$/.test(m.mime)) throw bad('Invalid MIME type');
}

/** Encrypt file bytes. Upload `blob`; send `descriptor` (plus the upload ref) inside an encrypted message. */
export async function encryptAttachment(data: Uint8Array, meta: AttachmentMeta): Promise<{ blob: Uint8Array; descriptor: AttachmentDescriptor }> {
  checkMeta(meta);
  if (data.length > ATTACHMENT_MAX_BYTES) throw bad(`Attachment exceeds ${ATTACHMENT_MAX_BYTES} bytes`);
  const s = subtle();
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const key = await s.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const prefix = globalThis.crypto.getRandomValues(new Uint8Array(8));
  const count = Math.max(1, Math.ceil(data.length / ATTACHMENT_CHUNK_BYTES));
  const h = header(ATTACHMENT_CHUNK_BYTES, count, prefix);
  const blob = new Uint8Array(HEADER_BYTES + data.length + count * TAG);
  blob.set(h, 0);
  let off = HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const pt = data.subarray(i * ATTACHMENT_CHUNK_BYTES, (i + 1) * ATTACHMENT_CHUNK_BYTES);
    const ct = new Uint8Array(await s.encrypt({ name: 'AES-GCM', iv: nonce(prefix, i), additionalData: aad(h, i, i === count - 1) }, key, pt.slice()));
    blob.set(ct, off);
    off += ct.length;
  }
  const sha256 = b64(new Uint8Array(await s.digest('SHA-256', blob)));
  const descriptor: AttachmentDescriptor = { v: 1, key: b64(raw), sha256, size: data.length, name: meta.name, mime: meta.mime };
  raw.fill(0);
  return { blob, descriptor };
}

/** Validate a descriptor received inside a decrypted message (untrusted input). */
export function parseAttachmentDescriptor(x: unknown): AttachmentDescriptor {
  const d = x as Partial<AttachmentDescriptor> | null;
  if (!d || typeof d !== 'object' || d.v !== 1) throw bad('Unsupported attachment descriptor');
  if (typeof d.key !== 'string' || unb64(d.key).length !== 32) throw bad('Invalid attachment key');
  if (typeof d.sha256 !== 'string' || unb64(d.sha256).length !== 32) throw bad('Invalid attachment hash');
  if (!Number.isSafeInteger(d.size) || d.size! < 0 || d.size! > ATTACHMENT_MAX_BYTES) throw bad('Invalid attachment size');
  if (d.ref !== undefined && (typeof d.ref !== 'string' || d.ref.length > 512)) throw bad('Invalid attachment ref');
  checkMeta({ name: d.name as string, mime: d.mime as string });
  return { v: 1, key: d.key, sha256: d.sha256, size: d.size!, name: d.name!, mime: d.mime!, ...(d.ref !== undefined ? { ref: d.ref } : {}) };
}

/** Verify and decrypt a downloaded blob. Throws DECRYPT_FAILED on any mismatch; never returns partial data. */
export async function decryptAttachment(blob: Uint8Array, descriptor: AttachmentDescriptor): Promise<Uint8Array> {
  const d = parseAttachmentDescriptor(descriptor);
  const s = subtle();
  const fail = (m: string) => new CryptoError('DECRYPT_FAILED', m);
  const digest = new Uint8Array(await s.digest('SHA-256', blob as Uint8Array<ArrayBuffer>));
  const want = unb64(d.sha256);
  let diff = digest.length ^ want.length;
  for (let i = 0; i < digest.length; i++) diff |= digest[i]! ^ (want[i] ?? 0);
  if (diff) throw fail('Attachment hash mismatch');
  if (blob.length < HEADER_BYTES || MAGIC.some((b, i) => blob[i] !== b) || blob[4] !== ATTACHMENT_VERSION) throw fail('Bad attachment header');
  const h = blob.slice(0, HEADER_BYTES);
  const dv = new DataView(h.buffer);
  const chunkSize = dv.getUint32(8), count = dv.getUint32(12);
  const expectCount = Math.max(1, Math.ceil(d.size / chunkSize));
  if (chunkSize < 1 || chunkSize > 1 << 24 || count !== expectCount || blob.length !== HEADER_BYTES + d.size + count * TAG) throw fail('Attachment length mismatch');
  const prefix = h.subarray(16, 24);
  const raw = unb64(d.key);
  const key = await s.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  raw.fill(0);
  const out = new Uint8Array(d.size);
  let off = HEADER_BYTES, w = 0;
  for (let i = 0; i < count; i++) {
    const len = Math.min(chunkSize, d.size - i * chunkSize) + TAG;
    try {
      const pt = new Uint8Array(await s.decrypt({ name: 'AES-GCM', iv: nonce(prefix, i), additionalData: aad(h, i, i === count - 1) }, key, blob.slice(off, off + len)));
      out.set(pt, w); w += pt.length;
    } catch (e) {
      out.fill(0);
      throw new CryptoError('DECRYPT_FAILED', 'Attachment chunk failed authentication', { cause: e });
    }
    off += len;
  }
  return out;
}
