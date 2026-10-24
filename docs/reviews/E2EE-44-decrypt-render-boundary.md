# E2EE-44 (P4-3): Crypto review of the decrypt/render boundary

Reviewer: Senior crypto engineer. Date: 2026-10-24. Scope: `frontend/src/features/chat/**`, `frontend/src/lib/api/**`, `frontend/next.config.ts`, `frontend/src/middleware.ts`, `packages/crypto` (main @ 7e269cb).

## Acceptance criteria

| Criterion | Result | Evidence |
|---|---|---|
| Plaintext stays client-side | **Pass** | Only `ciphertext` (opaque base64) and `version` are sent (`data/wire.ts` `sendMessageRequestSchema`). The `/api/*` proxy forwards bytes only. There is no plaintext in URLs, headers, logs, `localStorage` or `sessionStorage` (verified with grep). `ChatView` holds plaintext only in React state. |
| No mock crypto in prod build | **Pass**, now enforced | `chatAdapter()` returns `fixturesAdapter` only when `NODE_ENV !== "production"` and the flag is set, so the production default is `unavailableAdapter` (honest "coming soon"). New `tests/security/prod-bundle-scan.mjs` fails if fixture data, the fixtures flag, mock-crypto or relay names, PEM private keys or server secret names appear in `frontend/.next/static`. Current build: OK. |

## Findings

1. **Render is text-only (OK).** Bubbles render `{m.text}` as a React text node, and there is no `dangerouslySetInnerHTML`, `innerHTML`, markdown or linkify. The nonce CSP (E2EE-67) is defense in depth.
2. **Spoofing via control/bidi characters (fixed in crypto).** Decrypted plaintext is attacker-controlled. RLO/LRI (Trojan-Source) and C0/C1 controls can make a message display something other than what it says. Added `toDisplayText()` in `@e2ee/crypto`: it strips those characters, normalizes CRLF to LF and NFC, and caps output at 4000 chars. **Frontend action:** the HTTP+crypto ChatAdapter must map `MessageView.text = toDisplayText(plaintext)` and use the same function for conversation `preview`.
3. **Errors never carry plaintext (OK).** `CryptoError` messages are fixed strings. Frontend error states show generic copy.
4. **Integration not wired yet (note).** The production adapter is still `unavailableAdapter`. When the real adapter lands:
   - decrypt failures (`DECRYPT_FAILED`/`NO_SESSION`) must render a placeholder ("Couldn't decrypt this message"), never ciphertext;
   - `IDENTITY_CHANGED` must block send, which the adapter already enforces (E2EE-37);
   - do not cache plaintext beyond the browser's crypto store.
5. **Retry resends plaintext from memory (OK).** It's re-encrypted through the adapter, and nothing is persisted.

## Tests run
`pnpm lint && pnpm typecheck && pnpm build && pnpm test` (crypto 29/29, including `test/display.test.ts`), then `node tests/security/prod-bundle-scan.mjs` (OK).
