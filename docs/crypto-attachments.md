# Encrypted attachments (E2EE-47 / P5-1)

Status: **proposed format, pending review/approval** (acceptance: "format documented & approved").
Code: `packages/crypto/src/attachments.ts`; tests: `packages/crypto/test/attachments.test.ts`.

## Flow
1. Sender: `encryptAttachment(bytes, {name, mime})` → `{ blob, descriptor }`.
2. Upload `blob` (opaque bytes) to the server; the server returns a `ref`.
3. Send `{...descriptor, ref}` **inside an Olm-encrypted chat message** (it is part of the plaintext JSON).
   The file key, name, MIME type and size never leave the client in clear.
4. Receiver: `parseAttachmentDescriptor(untrusted)` → download `ref` → `decryptAttachment(blob, descriptor)`.

## Primitives
WebCrypto only: AES-256-GCM (128-bit tag), SHA-256, CSPRNG. No custom crypto.

## Key handling
- Fresh random 256-bit key per file; never reused, never sent to the server, never persisted outside the
  encrypted message history (which is itself encrypted at rest by the history store).
- Imported as a non-extractable `CryptoKey`; raw key buffers are zeroed after import (best effort).

## Blob layout (version 1)
```
header (24 B): "E2A1" | ver=1 | 3 B reserved | chunkSize u32 BE | chunkCount u32 BE | noncePrefix 8 B (random)
chunk i      : AES-GCM(key, nonce = noncePrefix || u32 BE i, aad = header || u32 BE i || finalFlag u8) = ct || tag
```
- `chunkSize` = 64 KiB plaintext; last chunk may be shorter; an empty file is one empty chunk.
- Nonces are unique because the key is unique per file and the counter is unique per chunk.
- AAD binding gives: **reorder** (index), **truncation/extension** (final flag + count in header),
  **header tampering** (whole header in every AAD), **cross-file splicing** (different key) all fail.

## Authenticated metadata
Descriptor (inside the E2EE message, so authenticated by Olm):
`{ v: 1, ref?, key (b64 32 B), sha256 (b64, of the whole blob), size, name, mime }`.
- `sha256` lets the receiver reject a swapped/corrupted download before decrypting; `size` must match the
  header-derived length exactly.
- `name`: 1–255 chars, no control chars or path separators. `mime`: `type/subtype` only (no parameters).
  The UI must still treat both as display text (use `toDisplayText`) and must not render attachments as HTML.
- Decryption is all-or-nothing: any failure throws `DECRYPT_FAILED` and no partial plaintext is returned.

## File size limit — decision
**25 MiB per file** (`ATTACHMENT_MAX_BYTES`), enforced on encrypt and on descriptor parse.
Rationale: whole-file in-memory encrypt/decrypt in the browser stays bounded; matches common chat-app
limits; chunked format already allows a later streaming implementation (and a higher limit) without
a format change. The backend upload endpoint should enforce `25 MiB + 24 + ceil(size/64Ki)*16` bytes.

## Out of scope / follow-ups
Backend blob upload/download endpoints and frontend UI; streaming (ReadableStream) encryption; thumbnails
(must be encrypted as separate attachments, never generated server-side).
