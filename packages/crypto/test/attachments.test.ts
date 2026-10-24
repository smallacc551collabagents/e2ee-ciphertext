import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_CHUNK_BYTES, ATTACHMENT_MAX_BYTES, decryptAttachment, encryptAttachment, parseAttachmentDescriptor, type AttachmentDescriptor,
} from '../src/index.js';

const rand = (n: number) => { const u = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(u.subarray(i, i + 65536)); return u; };
const meta = { name: 'photo.jpg', mime: 'image/jpeg' };
const sha = async (b: Uint8Array) => Buffer.from(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>)).toString('base64');
// Re-sign the outer hash so tests reach the per-chunk AEAD checks (attacker controlling the descriptor hash is the worst case).
const rehash = async (d: AttachmentDescriptor, b: Uint8Array): Promise<AttachmentDescriptor> => ({ ...d, sha256: await sha(b) });
const H = 24, T = 16, C = ATTACHMENT_CHUNK_BYTES + T;

describe('attachments (E2EE-47)', () => {
  it('round-trips empty, small, exact-chunk and multi-chunk files', async () => {
    for (const n of [0, 1, ATTACHMENT_CHUNK_BYTES, ATTACHMENT_CHUNK_BYTES * 3 + 7]) {
      const data = rand(n);
      const { blob, descriptor } = await encryptAttachment(data, meta);
      expect(blob.length).toBe(H + n + Math.max(1, Math.ceil(n / ATTACHMENT_CHUNK_BYTES)) * T);
      expect(await decryptAttachment(blob, descriptor)).toEqual(data);
    }
  });

  it('server-visible blob carries no metadata or key; each file gets a fresh key', async () => {
    const data = new TextEncoder().encode('hello hello hello');
    const a = await encryptAttachment(data, { name: 'secret-plan.txt', mime: 'text/plain' });
    const b = await encryptAttachment(data, { name: 'secret-plan.txt', mime: 'text/plain' });
    const s = Buffer.from(a.blob).toString('latin1');
    expect(s).not.toContain('secret-plan');
    expect(s).not.toContain('hello');
    expect(s).not.toContain(Buffer.from(a.descriptor.key, 'base64').toString('latin1'));
    expect(a.descriptor.key).not.toBe(b.descriptor.key);
    expect(Buffer.from(a.blob).equals(Buffer.from(b.blob))).toBe(false);
  });

  it('rejects a blob that does not match the descriptor hash', async () => {
    const { blob, descriptor } = await encryptAttachment(rand(100), meta);
    const t = blob.slice(); t[H + 3]! ^= 1;
    await expect(decryptAttachment(t, descriptor)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('per-chunk AEAD rejects bit flips, reordering, truncation, extension and header edits even with a matching hash', async () => {
    const data = rand(ATTACHMENT_CHUNK_BYTES * 3);
    const { blob, descriptor } = await encryptAttachment(data, meta);
    const flip = blob.slice(); flip[H + C + 5]! ^= 1;
    const swap = blob.slice(); swap.set(blob.subarray(H, H + C), H + C); swap.set(blob.subarray(H + C, H + 2 * C), H);
    const trunc = blob.slice(0, H + 2 * C);
    const hdr = blob.slice(); hdr[20]! ^= 1; // nonce prefix
    for (const [b, d] of [
      [flip, descriptor], [swap, descriptor], [hdr, descriptor],
      [trunc, { ...descriptor, size: ATTACHMENT_CHUNK_BYTES * 2 }], // drop final chunk and lie about size
    ] as const) {
      await expect(decryptAttachment(b, await rehash(d, b))).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
    }
    // Splice a chunk from another file encrypted under a different key.
    const other = await encryptAttachment(rand(ATTACHMENT_CHUNK_BYTES * 3), meta);
    const splice = blob.slice(); splice.set(other.blob.subarray(H + C, H + 2 * C), H + C);
    await expect(decryptAttachment(splice, await rehash(descriptor, splice))).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('rejects the wrong key', async () => {
    const { blob, descriptor } = await encryptAttachment(rand(10), meta);
    const other = await encryptAttachment(rand(10), meta);
    await expect(decryptAttachment(blob, { ...descriptor, key: other.descriptor.key })).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('enforces the size limit and validates descriptor/meta as untrusted input', async () => {
    await expect(encryptAttachment(new Uint8Array(ATTACHMENT_MAX_BYTES + 1), meta)).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });
    await expect(encryptAttachment(rand(1), { name: '../etc/passwd', mime: 'text/plain' })).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });
    await expect(encryptAttachment(rand(1), { name: 'a.txt', mime: 'text/html; charset=x' })).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });
    const { descriptor } = await encryptAttachment(rand(1), meta);
    expect(parseAttachmentDescriptor(JSON.parse(JSON.stringify({ ...descriptor, ref: 'att/123' })))).toMatchObject({ ref: 'att/123' });
    for (const bad of [null, { ...descriptor, v: 2 }, { ...descriptor, key: 'AAAA' }, { ...descriptor, size: -1 }, { ...descriptor, size: ATTACHMENT_MAX_BYTES + 1 }, { ...descriptor, name: '' }]) {
      expect(() => parseAttachmentDescriptor(bad)).toThrow();
    }
  });
});
