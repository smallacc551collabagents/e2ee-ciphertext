# Group protocol decision (E2EE-53 / P6-1)

Status: **Decision — groups stay DISABLED for the MVP.** Phase 6 is optional and gated (P5-G, opened only by
web-chat lead + Crypto). Reviewed 2026-10-24; re-check library status before reopening.

## Enforcement
`packages/crypto/src/groups.ts`: `GROUPS_ENABLED = false`; `assertDirectConversation(members, self)` must be
called before encrypt and throws `INVALID_OPTIONS` for anything other than exactly two members incl. self.
Backend/Frontend should not offer group creation (follow-up for those owners).

## Options considered
| Option | Library for the browser | Assurance | Verdict |
|---|---|---|---|
| Signal Sender Keys | libsignal (`@signalapp/libsignal-client`) is a Node native module; no supported browser/WASM build | audited, but not usable in-browser | Rejected (no supported lib) |
| MLS (RFC 9420) – OpenMLS | Rust; compiles to wasm32 but no first-party supported JS/WASM package — we would own the bindings | independent SRLabs audit (final report Mar 2026) | Not now: own-binding maintenance = custom crypto glue |
| MLS – ts-mls | Pure TypeScript, browser-ready | **No security audit** (per its README) | Rejected for production |
| Megolm (Matrix) | `@matrix-org/matrix-sdk-crypto-wasm`, already our 1:1 library (vodozemac) | vodozemac audited (2022); widely deployed | **Preferred path if Phase 6 opens** |

## If Phase 6 is opened
Use Megolm group sessions from the library we already ship (no new crypto dependency), distributing room keys
over existing Olm 1:1 sessions, gated by the identity gate and revocation check (E2EE-37/E2EE-50).
Known Megolm trade-offs to accept explicitly: weaker post-compromise security than MLS (session rotation by
message count/time and on membership change mitigates), O(n) key distribution, server sees membership.
Revisit MLS when an audited RFC 9420 implementation ships a supported browser package.
Required before enabling: new design review, threat-model update, rotation-on-leave tests, external review.
