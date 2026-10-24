# Encrypted attachments — backend (E2EE-47)

Format and client flow: [crypto-attachments.md](crypto-attachments.md). This doc covers the blob transport.

## Opaque-only guarantee
The server stores **only opaque ciphertext** and this metadata: a random `ref`, owner user id,
conversation id, ciphertext `size_bytes`, ciphertext `sha256` (from the descriptor), status and timestamps.
It **never** sees or stores the file key, plaintext, file name, MIME type or any other descriptor field;
those travel only inside the Olm-encrypted message (`{...descriptor, ref}`). Request bodies with extra
fields (e.g. `name`, `mime`) are rejected (400). The server **never** generates thumbnails, previews or
any derived media; the only thing it does with the bytes is hash the ciphertext once on `complete`.
What it does learn: which conversation a blob belongs to, its ciphertext size, and who uploaded it.

## Storage: Neon Object Storage
- Why: already on Neon (one provider, one bill), S3-compatible, branches with the DB, and our project
  (`old-mouse-66326385`, `aws-us-east-1`) is in a supported region. **Free plan includes 5 GB of object
  storage per project at no cost** (the account is on the Free plan, `free_v3`, which has no billing).
  Vercel Blob was not needed.
- Bucket: `e2ee-attachments` (private), on branch `main` (`br-soft-king-b7v7ki41`). Object key: `a/<ref>`.
- Blobs never pass through the Vercel function (≈4.5 MB body limit). Browsers upload with a
  **presigned POST** and download with a **presigned GET** directly against storage.
- **Single stable origin** (path-style, so no per-bucket host):
  `https://br-soft-king-b7v7ki41.storage.c-13.us-east-1.aws.neon.tech`
  Frontend must add exactly this origin to CSP `connect-src`.
- Bucket CORS (configured): origins `https://e2ee-ciphertext-frontend.vercel.app`, `http://localhost:3000`;
  methods `GET`, `POST`; headers `*`; expose `ETag`; max-age 600.
- Verified live against Neon (Oct 24, 2026): presigned POST works; a body over `content-length-range`
  is rejected (400); a different `key` than the signed one is rejected (403); CORS preflight +
  `Access-Control-Allow-Origin` returned for the frontend origin.

## Size cap
`ATTACHMENT_MAX_CIPHERTEXT_BYTES = 25 MiB + 24 + ceil(25 MiB / 64 KiB) * 16 = 26,220,824` bytes
(max plaintext 25 MiB + 24 B header + 16 B GCM tag per 64 KiB chunk). Enforced twice:
1. API validation of the declared `size` (40 ≤ size ≤ cap).
2. **Signed into the presigned POST policy**: `["content-length-range", 1, cap]` plus
   `["eq", "$key", "a/<ref>"]` (exact key, no prefix). Storage rejects anything else.
`complete` then checks the stored object's exact size and sha256 against what was declared.
(TODO: import the constant from `@e2ee/crypto` once it exports it; currently computed identically.)

## Endpoints (all require the `e2ee_session` cookie, else 401)
### `POST /attachments/upload-url`
Body `{ conversationId: uuid, size: int, sha256: base64(32 B) }` — caller must be a member (else 404).
→ `201 { ref, upload: { url, fields }, expiresAt, maxBytes }`
`upload` is a **presigned POST**: build `multipart/form-data` with every entry of `fields` (in order),
then the blob as the **last** field named `file`, and `POST` it to `upload.url`. Success is `204`.
`ref` = 256-bit random, base64url (43 chars); no user id or predictable path. URL lifetime: 5 min.
Rate limit: 30/min/user.
### `POST /attachments/:ref/complete`
Owner only. Verifies object exists, size == declared, sha256 == declared → `200 { ref, status: "stored" }`
(idempotent). Mismatch → object and row deleted, `422 integrity_mismatch`. Not uploaded → `409`.
Upload window lapsed → `410`. Rate limit: 30/min/user.
### `GET /attachments/:ref/download-url`
→ `200 { downloadUrl, expiresAt }` (presigned GET, 5 min, served as `application/octet-stream`).
Only **members of the conversation the blob was uploaded to**, and only when `status = stored`.
Unknown/pending/expired/non-member all return the same `404`. Rate limit: 120/min/user.

Rate limits use the shared Postgres limiter (E2EE-75) and fail open on store errors, like the other
non-auth endpoints.

## Lifecycle and garbage collection
`pending` (expires 15 min after `upload-url`) → `complete` → `stored` (expires 30 days after completion).
`sweepAttachments()` deletes the object then the row for anything with `expires_at < now()` (bounded,
50 per call). It runs on ~5% of `upload-url` requests (same sampled pattern as the rate-limit cleanup)
and is exported for a future cron. Expired rows are never served even before they are swept.

## Required configuration (Vercel backend project env; never committed)
| Var | Value |
| --- | --- |
| `AWS_ENDPOINT_URL_S3` | `https://br-soft-king-b7v7ki41.storage.c-13.us-east-1.aws.neon.tech` |
| `AWS_REGION` | `us-east-1` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | A Neon storage credential (`storage:read` + `storage:write`) on branch `main`: Neon Console → project → Settings → Credentials → Create credential (or Connect → Storage → Reveal), or `neon credentials create --scope storage:read --scope storage:write --name e2ee-backend-attachments`. Access key id = `nak_live_…` token id, secret = `nsk_live_…`. |
| `ATTACHMENTS_BUCKET` | optional, default `e2ee-attachments` |
No new GitHub Actions secrets are needed (migrations use the existing `DATABASE_URL_DIRECT`).
