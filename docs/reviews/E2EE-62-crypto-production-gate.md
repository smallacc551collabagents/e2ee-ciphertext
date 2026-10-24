# E2EE-62 / P7-5 — Crypto production gate

Status: **Gate implemented; staging sign-off pending** (acceptance: sign-off on staging build; depends on P7-4).

## Automated checks (run in CI on every PR and push to main)
`pnpm run gate:crypto` → `tests/security/crypto-prod-gate.mjs` (+ its self-tests):
- `packages/crypto/src`: no `Math.random`, no imports from `test/`, no test doubles (`FakeBackend`, `InMemoryRelay`,
  `memGate`, `mock*`), no bypass switches (`skipVerif*`, `bypass*`, `insecure*`, `disableE2EE`…), no `process.env`
  (keys never come from env).
- `frontend` (non-test files): only allow-listed `NEXT_PUBLIC_*` names (`API_URL`, `WS_URL`, `CHAT_FIXTURES`);
  nothing secret-looking may be public; the fixtures switch must be gated on `NODE_ENV`.
- Repo: no committed `.env*` (only `*.example`), no PEM private keys, secret-named example values are placeholders.

`pnpm run gate:bundle` → `tests/security/prod-bundle-scan.mjs` on `frontend/.next/static` (after build):
no fixtures, no fixtures switch, no mock crypto, no private keys, no server secret names.

Structural guarantees already in code: `identityGate` is required (E2EE-37, #23); no plaintext/secret in errors;
Olm store wrapped by a non-extractable WebCrypto key (no key in env/storage); groups disabled (E2EE-53).

## Staging sign-off checklist (manual, against the deployed staging build)
- [ ] `pnpm run gate:crypto` and `gate:bundle` green on the release commit.
- [ ] Vercel project env (Preview/Production): only `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_WS_URL` public; `PROXY_SHARED_SECRET`,
      `BACKEND_URL` server-only; `NEXT_PUBLIC_CHAT_FIXTURES` unset.
- [ ] Download staging JS chunks and run `prod-bundle-scan.mjs` on them.
- [ ] Chat adapter in the staging build is the real Olm adapter (not `unavailableAdapter`/fixtures) once wired; DevTools
      network shows only ciphertext envelopes in `/messages` bodies.
- [ ] CSP from P7-4 allows `wasm-unsafe-eval` only (needed for the crypto WASM), no `unsafe-eval`.
- [ ] Crypto owner sign-off recorded on E2EE-62.

Current blocker for sign-off: P7-4 staging deploy, and the frontend still ships `unavailableAdapter` (real adapter not yet wired).
