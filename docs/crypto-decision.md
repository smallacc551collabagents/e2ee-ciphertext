# Crypto library decision (E2EE-13)

Status: **Proposed**, pending System Architecture review. Evaluated on 2026-10-24.

## Requirements
- It must run in the browser (and in Node for tests), with no native addon.
- It must be audited and maintained. We will not write our own crypto or protocol.
- It must provide asynchronous 1:1 sessions with forward secrecy and post-compromise security, using signed prekeys and one-time prekeys.
- Its license must be compatible with a closed or commercial web app.

## Candidates

| Option | Version | License | Browser | Assessment |
|---|---|---|---|---|
| `@signalapp/libsignal-client` | 0.106.0 | AGPL-3.0-only | **No.** It is a native Node addon only, and upstream says it is unsupported outside Signal. | Rejected |
| `@privacyresearch/libsignal-protocol-typescript` | 0.0.16 | GPL-3.0-only | Yes | Rejected: unofficial, unaudited port, and GPL |
| `@matrix-org/olm` (libolm) | 3.2.15 | Apache-2.0 | Yes | Rejected: deprecated, with known timing side-channel issues |
| Standalone vodozemac JS bindings | various | various | Yes | Rejected: only unofficial third-party wrappers exist |
| OpenMLS WASM | 0.1.x | MIT | Yes | Rejected for now: unofficial, immature npm packages |
| **`@matrix-org/matrix-sdk-crypto-wasm`** | **18.9.0** | **Apache-2.0** | **Yes (WASM)** | **Recommended** |

## Recommendation
Use **`@matrix-org/matrix-sdk-crypto-wasm`**, pinned to an exact version.
- It is the official Matrix.org WASM build of `matrix-sdk-crypto`, and it uses **vodozemac**. Vodozemac is a Rust Olm/Megolm implementation, audited by Least Authority in 2022, and it ships in Element Web.
- Olm is a Double Ratchet protocol with X3DH-style session setup using Curve25519, Ed25519, AES-256-CBC and HMAC-SHA-256.
- The library handles device-key signatures, one-time and fallback keys, session management and replay protection. It also provides an encrypted IndexedDB store.
- We use its wire format and request model (keys upload, query, claim and to-device). The backend only has to implement those endpoints over opaque JSON. The PoC in `packages/crypto` shows this working.
- Trade-offs:
  - The WASM bundle is about 5 MB, so it should be lazy-loaded.
  - The API is Matrix-shaped, so we hide it behind the `CryptoAdapter` contract. That keeps the library swappable.

## Decision: libsignal / AGPL
**Do not adopt libsignal for the MVP.** There is no supported browser build, which by itself rules it out. On top of that, AGPL-3.0 would require offering the source of the network service. Any future use (for example, native mobile) needs a written legal review first.

## Decision: multi-device scope
**The MVP supports one active device per account.** The protocol and contract already address every message to a specific `(userId, deviceId)`, so multi-device can be added later without changing the wire format. When we add it, the main work is fan-out to all of a user's devices, cross-signing, and history sharing.

## Out of scope / later
Group chats (Megolm vs MLS) need their own decision. Key backup also needs its own decision.
