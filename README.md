# e2ee-chat

Signal-inspired end-to-end encrypted web chat. The server stores and routes ciphertext only.

## Layout
- `frontend/` Next.js + React (Frontend)
- `backend/` Node.js + TypeScript, Fastify + Prisma (Backend)
- `packages/crypto` browser-side E2EE (Crypto) · `packages/shared` shared types/schemas/events (Backend)
- `agents/` agent briefs · `tests/` e2e/security/integration (QA) · `docs/` docs

See `OWNERS.md` for ownership and PR rules.

## Local dev
```
corepack enable && pnpm install
docker compose up -d postgres
cp .env.example .env
pnpm typecheck
```
