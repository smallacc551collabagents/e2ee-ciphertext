# Key lifecycle (E2EE-13/14)

This document describes how keys are handled by `packages/crypto`, which runs on `@matrix-org/matrix-sdk-crypto-wasm` (vodozemac Olm). The server only ever stores public keys and ciphertext.

## Identity keys
- Each device generates an **Ed25519** signing key and a **Curve25519** identity key on first run (`OlmMachine`). These keys are generated locally and are never exported.
- Both public keys are published in the signed `device_keys` object. `identity()` returns them, and so does `peerIdentities()` for other users.

## Signed prekeys / device bundle
- The device bundle (`device_keys`) is signed with the device's Ed25519 key. The library **verifies this signature when it processes the bundle returned by `keys.query`**. A bundle that fails verification is dropped, and `encrypt` then fails with `NO_DEVICE`. There is a test for this.
- A signed **fallback key** stands in for a classic signed prekey when the one-time keys run out. The library rotates it.

## One-time prekeys
- The client uploads a batch of signed one-time keys and tops it up whenever the server reports that the count is low.
- **The server must claim keys atomically.** `keys.claim` has to pop a key in a single transaction, for example with `DELETE … RETURNING` or `SELECT … FOR UPDATE SKIP LOCKED`, so that no key is ever handed out twice. The test relay in `test/relay.ts` models this, and there is a test for it.

## Session state
- Olm (Double Ratchet) sessions are created on first send from a claimed one-time key. They are then used for later messages and ratchet forward with each one.
- The library rejects duplicate (replayed) and tampered messages. The receiver also checks that:
  - the authenticated sender key belongs to the claimed sender device (otherwise `IDENTITY_CHANGED`)
  - the envelope is addressed to this device (otherwise `INVALID_ENVELOPE`)

## Storage
- All crypto state is stored in the library's IndexedDB store, which encrypts it with a 32-byte store key.
- The store key is wrapped with AES-GCM under a **non-extractable WebCrypto `CryptoKey`**, which is itself kept in IndexedDB (`store-key.ts`). Script running on the page cannot export the raw wrapping key.
- The raw store key is zeroed once the store has been opened.
- Nothing is ever placed in env vars, logs or `localStorage`.

## Multi-tab safety
Startup (getting or creating the store key and opening the store) and all ratchet-mutating operations run inside a **Web Lock** (`navigator.locks`) named per store (`lock.ts`). Two tabs therefore cannot advance the same ratchet concurrently. Where Web Locks is not available (Node tests), an in-process queue is used instead.

## Identity change & safety numbers
- The safety number is derived from both parties' Ed25519 identity keys, and the UI shows it for manual comparison.
- If a peer's identity key changes (for example, after a reinstall or a password reset), the app must:
  - show a blocking warning
  - require the user to acknowledge it before sending
  - mark any previous verification as stale
- The adapter reports a mismatch as `IDENTITY_CHANGED`. The UI warning is not yet implemented.

## Password reset
- The account password is used **only** for server authentication. It never derives, wraps or unlocks key material.
- A password reset therefore does not recover keys. The device generates **new identity keys**, the old device is revoked, and peers see an identity-change warning. Past messages on the old device are lost unless key backup is added later.

## Device revoke
- When a device is revoked, the server:
  - deletes its device keys and any one-time keys not yet claimed
  - stops delivering envelopes to it
  - notifies peers so they drop it on the next `keys.query`
- On logout, the client deletes its IndexedDB store (crypto store and wrapping key).

## Known limitations
- The raw store key is held in WASM and JS memory while the store is open. A successful XSS attack can use the keys while the session is live, so a strict CSP is required.
- Replay and tampering both surface as `DECRYPT_FAILED`; the two cannot be told apart.
- Metadata is visible to the server: who talks to whom, when, and message sizes.
- There is no key backup or history sharing. Clearing browser storage means losing past messages.
- The MVP supports a single device per account (see `crypto-decision.md`).
- The tests use `fake-indexeddb`, and the relay is a test double. All the crypto in the tests is real.
- The WASM bundle is about 5 MB and has to be lazy-loaded.
