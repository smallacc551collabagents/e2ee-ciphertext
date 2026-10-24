# Crypto wire format v1 (packages/crypto ↔ Phase 1 backend)

Backend PR #13 stores `bytes + version`. `version = 1` means (all bytes UTF-8 JSON, standard padded base64):

| backend field | contents |
|---|---|
| `identityKey.publicKey` | the library's self-signed device-keys object (`user_id`, `device_id`, curve25519 + ed25519, ed25519 signature) |
| `signedPrekey.publicKey` | `{id, key}` where `key` is the signed Curve25519 fallback key; `signature` = its raw 64-byte ed25519 signature; `keyId` = counter from the library key id |
| `oneTimePrekeys[].publicKey` | `{id, key}` signed one-time Curve25519 key; `keyId` = counter from the library key id |
| message `ciphertext` | `CiphertextEnvelope` JSON: sender + recipient device, Olm message |

Client rules: signatures are verified by the library before any session is built; the bridge also rejects a bundle whose device keys name a different user. When `oneTimePrekey` is `null`, the signed prekey is used. Call `adapter.replenishPrekeys(count)` with `GET /keys/count`; the library uploads new keys when the pool is low.

Frontend usage: `createOlmAdapter({ userId: userIdFor(username), deviceId, transport: createBackendTransport(http), storeName, identityGate: createIdentityGate(peerStore) })` (`identityGate` is required: omitting it is a type error and throws `INVALID_OPTIONS` at runtime); send with `POST /conversations/:id/messages` body `encodeMessage(await adapter.encrypt(peer, text))`; receive with `adapter.receive(messages.map(decodeMessage))`. Single device per user, so there is one envelope per recipient. Safety numbers: `safetyNumber(me, peer)`; on first contact store the peer identity, then check it with `checkPeerIdentity` (it throws `IDENTITY_CHANGED`, which drives the banner).

## Key lookups

| library request | endpoint | consumes OTK? | when |
|---|---|---|---|
| keys.query | `GET /keys/identity/:username` -> `{ userId, username, identityKey{publicKey,version}, signedPrekey{keyId,publicKey,signature,version} }` (404 if no keys; no `oneTimePrekey` field) | no | only when the peer device isn't already in the encrypted store |
| keys.claim | `GET /keys/bundle/:username` (PR #13 shape) | yes, exactly one | only when there's no outbound Olm session yet |

Verified peer device keys are cached in the library's encrypted IndexedDB store. Receiving on an existing session makes no key calls, which the tests check.

## Peer identity refresh (E2EE-37)

`createPeerVerifier({ adapter, http, store })` re-reads `GET /keys/identity/:username`:
- (a) `onReceiveResults(results)`: for each sender with a failed message, once per batch.
- (b) `refreshStale(peerUserIds)`: on app start and on a timer; re-checks peers last checked ≥ 24h ago.

The published identity is compared with the one stored on first use (`checkPeerIdentity`). The status is `changed` (with `IDENTITY_CHANGED`) when the keys differ, or when the library didn't verify them, for example new keys under a device id we already know. The store is **not** updated. Only `acceptNewIdentity()` updates it, after the user re-verifies the safety number.

Backend dependency: after an identity reset, the new key counter restarts, so `(user_id, key_id)` uniqueness must cover only unused one-time prekeys. Otherwise the reset publish returns 409.

## Message history at rest (`historyStore`)

Decrypted history is kept only in the browser, encrypted. Usage for Frontend:

```ts
import { openHistoryStore, deleteLocalCryptoState } from '@e2ee/crypto';

const history = await openHistoryStore(storeName);          // same storeName as createOlmAdapter
const cached = await history.list(conversationId);          // render immediately (ascending seq)
const after = (await history.lastSeq(conversationId)) ?? '0';
// GET /conversations/:id/messages?after=<after>, then adapter.receive(messages.map(decodeMessage))
for (const [i, r] of results.entries()) {
  const m = messages[i];
  if (r.ok) await history.put(conversationId, m.seq, {
    id: m.id, senderUserId: r.sender.userId, senderDeviceId: r.sender.deviceId,
    text: r.plaintext, sentAt: m.createdAt, clientMsgId: m.clientMsgId,
  });
}
// Then POST /messages/ack. Store your own sent messages after the POST returns their seq.
```

- **Encryption:** each record is AES-256-GCM encrypted with a fresh IV. The key comes from HKDF-SHA-256 over the store's own non-extractable random base key, kept in IndexedDB `<storeName>-history`. The AAD binds `(conversationId, seq)`, so a tampered, moved or replayed record fails with `DECRYPT_FAILED`. Plaintext never appears in IndexedDB.
- **Cursor:** use `lastSeq(conversationId)` as the `after` cursor so already-decrypted messages are never re-fetched. Olm can't decrypt the same message twice, so history is the only way to re-render past messages after reload.
- **Clearing:** `clear()` removes all records. On **logout**, close the adapter and history store, then call `deleteLocalCryptoState(storeName)`. It deletes the Olm store, its wrapping key and the history DB together. If another tab has them open, it rejects with `STORAGE_FAILED`.
- **Rendering:** apply text-only rendering rules to `text` as for live messages.
