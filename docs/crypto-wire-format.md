# Crypto wire format v1 (packages/crypto ↔ Phase 1 backend)

Backend PR #13 stores `bytes + version`. `version = 1` means (all bytes UTF-8 JSON, standard padded base64):

| backend field | contents |
|---|---|
| `identityKey.publicKey` | the library's self-signed device-keys object (`user_id`, `device_id`, curve25519 + ed25519, ed25519 signature) |
| `signedPrekey.publicKey` | `{id, key}` where `key` is the signed Curve25519 fallback key; `signature` = its raw 64-byte ed25519 signature; `keyId` = counter from the library key id |
| `oneTimePrekeys[].publicKey` | `{id, key}` signed one-time Curve25519 key; `keyId` = counter from the library key id |
| message `ciphertext` | `CiphertextEnvelope` JSON: sender + recipient device, Olm message |

Client rules: signatures are verified by the library before any session is built; the bridge also rejects a bundle whose device keys name a different user. When `oneTimePrekey` is `null`, the signed prekey is used. Call `adapter.replenishPrekeys(count)` with `GET /keys/count`; the library uploads new keys when the pool is low.

Frontend usage: `createOlmAdapter({ userId: userIdFor(username), deviceId, transport: createBackendTransport(http), storeName })`; send with `POST /conversations/:id/messages` body `encodeMessage(await adapter.encrypt(peer, text))`; receive with `adapter.receive(messages.map(decodeMessage))`. Single device per user, so there is one envelope per recipient. Safety numbers: `safetyNumber(me, peer)`; on first contact store the peer identity, then check it with `checkPeerIdentity` (it throws `IDENTITY_CHANGED`, which drives the banner).

## Key lookups

| library request | endpoint | consumes OTK? | when |
|---|---|---|---|
| keys.query | `GET /keys/identity/:username` -> `{ userId, username, identityKey{publicKey,version}, signedPrekey{keyId,publicKey,signature,version} }` (404 if no keys; no `oneTimePrekey` field) | no | only when the peer device isn't already in the encrypted store |
| keys.claim | `GET /keys/bundle/:username` (PR #13 shape) | yes, exactly one | only when there's no outbound Olm session yet |

Verified peer device keys are cached in the library's encrypted IndexedDB store. Receiving on an existing session makes no key calls, which the tests check.
