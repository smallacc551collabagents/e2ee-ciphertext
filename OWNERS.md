# Owners

| Path | Owner |
|---|---|
| root config (`package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, `eslint.config.mjs`, `.env.example`, `docker-compose.yml`), `backend/`, `packages/shared/`, `docs/api-contracts.md` | Backend |
| `frontend/` (incl. `next.config.ts`) | Frontend |
| `packages/crypto/`, `docs/crypto-decision.md` | Crypto |
| `tests/`, `.github/workflows/`, `docs/test-plan.md` | Testing bot / QA |
| `docs/reviews/`, `docs/architecture.md`, `docs/security.md` | System Architecture / Supervisor |

## Branch & PR rules
- Never push to `main`. Branch as `feat/<area>-<topic>`, `fix/...`, `chore/...`.
- Open a PR into `main`; System Architecture reviews; path owner must approve changes in their paths.
- CI (typecheck) must be green before merge. Small PRs, one concern each.
- Work only after Mustafa's individual go-ahead.

## Non-negotiables
- No plaintext message bodies or private/session/file keys in server DTOs, DB fields, logs, or env.
- Do not invent cryptography; use the audited library chosen in `docs/crypto-decision.md`.
- Crypto-dependent schema (devices, prekeys, envelopes) is frozen until the Phase 1 contract freeze.
- No server-side AI/RAG/analytics/moderation in the MVP.
