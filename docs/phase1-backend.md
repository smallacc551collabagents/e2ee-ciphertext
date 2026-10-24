# Phase 1 backend: transport contract

The server is a **dumb store-and-forward relay**. It stores only:
- users' **public** key material (identity key, signed prekey + signature, one-time prekeys), and
- **opaque ciphertext** envelopes plus routing metadata (conversation, sender, seq, timestamps, delivery state).

It never sees or stores plaintext, private keys, or session keys, and never parses key or ciphertext bytes.
Every key/envelope is `bytes + integer version`; **the byte format for each `version` belongs to `packages/crypto`**.
The server checks only that a field is present, is canonical base64, and fits the size cap.

## Data model (additive migration `20261024120000_phase1_transport`)
| table | purpose |
|---|---|
| `identity_keys` | one row per user: `identity_key`+version, `signed_prekey_id`, `signed_prekey`, `signed_prekey_signature`, +version (all `bytea`) |
| `one_time_prekeys` | public one-time prekeys `(user_id, key_id)` unique, `public_key bytea`, `version`, `consumed_at` (set atomically when handed out) |
| `conversations` | `kind` (`direct` now; `group` later), `direct_key` (sorted user-id pair, unique => idempotent 1:1), `last_seq` |
| `conversation_members` | `(conversation_id, user_id)`; N-ary so groups need no schema change |
| `messages` | `ciphertext bytea`, `version`, `sender_id`, per-conversation gap-free `seq`, `client_msg_id`; unique `(conversation_id, sender_id, client_msg_id)` for dedupe |
| `message_deliveries` | `(message_id, recipient_id)`, `delivered_at` |

Phase 1 is single-device per user. Multi-device would add a `devices` table and a device id on keys and deliveries, also additively.

## HTTP contract
Every route needs the `e2ee_session` cookie, or it returns 401. Errors look like `{ error, message }` and never include stack traces. Binary fields are standard base64 strings.

Caps: key or signature ≤ 1024 B; ciphertext ≤ 32 KiB; ≤ 100 one-time prekeys per publish; ≤ 500 unused one-time prekeys per user; `version` is an integer from 1 to 65535.

| method & path | body / query | response |
|---|---|---|
| `POST /keys/publish` | `{ identityKey?: {publicKey, version}, signedPrekey?: {keyId, publicKey, signature, version}, oneTimePrekeys?: [{keyId, publicKey, version}] }`. The first publish needs identityKey and signedPrekey. Rotating the identity key also needs a new signedPrekey and drops any unused one-time prekeys. signedPrekey can be rotated alone. | `{ oneTimePrekeyCount }`. A reused keyId returns 409; a full pool returns 409. |
| `GET /keys/count` | none | `{ oneTimePrekeyCount }` |
| `GET /keys/bundle/:username` | none | `{ userId, username, identityKey{publicKey,version}, signedPrekey{keyId,publicKey,signature,version}, oneTimePrekey{keyId,publicKey,version} \| null }`. Each one-time prekey is consumed atomically (`FOR UPDATE SKIP LOCKED`) and is never handed out twice. Returns 404 if the user has no keys. Limited to 60/min. |
| `POST /conversations` | `{ username }` | 201 if created, 200 if it already exists: `{ conversation{id, kind, members[{id,username}]} }`. Returns 404 for an unknown user and 400 for yourself. |
| `GET /conversations` | none | `{ conversations[{id, kind, lastSeq, createdAt, members}] }` |
| `POST /conversations/:id/messages` | `{ clientMsgId: [A-Za-z0-9_-]{8,64}, ciphertext, version }` | 201 `{ message, duplicate:false }`. A retry with the same clientMsgId returns 200 `{ message, duplicate:true }`. Returns 404 if you are not a member. Limited to 120/min. |
| `GET /conversations/:id/messages?after=<seq>&limit<=100` | none | `{ messages[{id, conversationId, senderId, seq, clientMsgId, ciphertext, version, createdAt}], nextCursor, hasMore }`. `seq` is a decimal string. Returns 404 if you are not a member. |
| `POST /messages/ack` | `{ messageIds: uuid[] (≤500) }` | `{ acked }`. Only the caller's own delivery rows are updated. Acking twice does nothing. |

Non-members get 404 rather than 403, so the API doesn't reveal which conversations exist.
