> **Update 2026-10-29:** the server contract that shipped is the one in `@e2ee/shared` (PR #55) and the backend (PR #56), and the crypto package matches it. The differences from the draft below: there is no `GET /groups/:id` (the group is read from `GET /conversations`, `kind:"group"`, `adminId`, `membershipVersion`); add takes `{usernames}`; a stale send returns **409 `membership_changed`** `{membershipVersion, members}`; leave returns `{groupDeleted}`; system events are `kind:"system"`; to-device is `{recipient, ciphertext, type, version}` with no device id, and the queue is dropped when the recipient's identity changes; a removed member gets 404. The draft follows for reference.

# Group chat E2EE — crypto API + expected server contract (proposal, E2EE-53 / Phase 6)

Owner: Crypto. Server contract owner: Backend (this is what the client needs; Backend may rename paths, tell Crypto).
Library: `@matrix-org/matrix-sdk-crypto-wasm` 18.9.0 (Megolm via `OlmMachine.shareRoomKey / encryptRoomEvent /
decryptRoomEvent / invalidateGroupSession / exportRoomKeys / importExportedRoomKeys`). No new crypto dependency.

## 1. Crypto rules (enforced in `packages/crypto/src/groups.ts`)
- One outbound Megolm session per group (`roomId = conversationId`).
- Rotate (`invalidateGroupSession`) whenever `membershipVersion` changes (add / remove / leave / admin change) and
  whenever the client has no record of the version it last shared for (e.g. after reload). Library rotation:
  `rotationPeriodMessages = 100`, `rotationPeriod = 7 days`.
- Room keys go to each member's CURRENT published device only, over Olm (to-device envelopes), after the identity
  gate (`assertUserNotPending` + `assertTrusted`, wrapped by `withRevocationCheck`). Members with an unaccepted
  identity change or no published keys get nothing and are returned in `pending`.
- Old sessions are never shared on join (a fresh session is created on every membership change), so new members
  cannot read pre-join history. Removed members never receive the post-removal session.
- Key requests (missing room key) are answered only by the session creator, only for sessions whose recorded member
  set contained the requester, only if the requester is a current member, and only via `encrypt()` (so the identity
  gate applies — a new device gets the key after its new identity is accepted).

## 2. Client API (for Frontend)
```ts
import { createGroupCrypto, type GroupBackend } from '@e2ee/crypto';
const groups = createGroupCrypto({ adapter /* createOlmAdapter(...) */, backend /* GroupBackend */, history? /* HistoryStore */ });

groups.send(conversationId, plaintext, clientMsgId?)   // -> { message, pending: string[] }
   // fetches members, rotates if membershipVersion changed, shares keys (to-device), encrypts, POSTs with
   // membershipVersion; on 409 stale_membership: refetch members, rotate, retry (max 3).
groups.receive(conversationId, messageDtos)             // -> GroupReceiveResult[] in seq order; ok results are written
   // to history (if given) BEFORE returning, so the caller acks after. Member events pass through as kind:'member_event'.
   // Missing key -> { ok:false, code:'MISSING_ROOM_KEY' } and a key request is sent automatically (UI: "Waiting for key").
groups.receiveToDevice(toDeviceDtos)                    // room keys, key requests (answered), key responses (imported).
   // Returns { retry: conversationIds[] } -> re-run receive() for messages that were waiting for a key.
groups.onMembershipChanged(conversationId)              // call on a member_event; forces rotation before next send.
groups.reshare(conversationId)                          // call after the user accepts a changed safety number.
```
Attachments: unchanged per-file key (`attachments.ts`); put the attachment descriptor JSON in the group plaintext.

## 3. Server contract expected by the client (Backend)
All ids are usernames on the wire (client maps to `@user:e2ee.local`).

| Method | Path | Body / result | Rules |
|---|---|---|---|
| POST | `/groups` | `{ name, members: string[] }` → `GroupDto` | creator = admin; each member must share a 1:1 conversation with the creator; cap 50 incl. creator |
| GET | `/groups/:id` | → `GroupDto` | caller must be a member (else 404) |
| POST | `/groups/:id/members` | `{ username }` → `GroupDto` | caller member; caller must have a 1:1 with `username` (403 `no_direct_chat`); 409 `group_full` |
| DELETE | `/groups/:id/members/:username` | → `GroupDto` | caller member; admin → 403 `cannot_remove_admin` |
| POST | `/groups/:id/leave` | → `{ deleted: boolean, group?: GroupDto }` | admin leaves → oldest remaining member (by joinedAt) becomes admin; last member → group + messages deleted |

`GroupDto = { id, name, adminUsername, membershipVersion: number, members: [{ username, joinedAt, joinedSeq: string }] }`
Every add/remove/leave/admin change increments `membershipVersion` (single per-conversation counter, in the same
transaction as the change).

Messages (existing `/conversations/:id/messages`, now also for groups):
- POST body gains `membershipVersion: number` (required for groups). If it ≠ current → **409**
  `{ error: 'stale_membership', membershipVersion }`. `ciphertext` is the base64 `GroupEnvelope` (opaque, ≤32 KiB).
- GET returns, interleaved by `seq`, server-generated member events:
  `{ id, seq, kind: 'member_event', event: { type: 'added'|'removed'|'left'|'admin_changed'|'created', actor, target, membershipVersion }, createdAt }`.
  Message DTOs get `kind: 'message'` (absent = message, for 1:1 compatibility).
- A member only receives messages with `seq > joinedSeq` (defence in depth; crypto already prevents reading them).
- Messages are stored once per conversation; per-member delivery/ack as for 1:1 (`POST /messages/ack`).
- Removed/left users get 404 on GET/POST for the group.

To-device queue (room keys, key requests/responses; per recipient DEVICE, store-and-forward like 1:1):
| Method | Path | Body / result |
|---|---|---|
| POST | `/to-device` | `{ messages: [{ recipient: username, recipientDeviceId, clientMsgId, ciphertext, version: 1 }] }` (≤ 50+ per call) |
| GET | `/to-device?after=<seq>&limit=` | `{ messages: [{ id, seq, sender: username, ciphertext, createdAt }], nextCursor, hasMore }` — only for the caller's current device |
| POST | `/to-device/ack` | `{ ids: string[] }` → deletes them |
Rules: sender must share a group or 1:1 with the recipient; recipientDeviceId must be the recipient's current
published device (else 409 `device_changed`); when a device is replaced, its undelivered to-device messages are
dropped (the client re-shares / re-requests after the identity is accepted); delete on account delete.
