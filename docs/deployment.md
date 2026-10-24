# Deployment

## CI (`.github/workflows/ci.yml`)
Runs on every pull request to `main` and every push to `main`. One `build` job (ubuntu-latest, Node 20, pnpm 9.12.0 with pnpm store cache):

1. `pnpm install --frozen-lockfile`
2. `pnpm run lint` (`eslint .`, always runs; `no-console` enforced)
3. `pnpm -r --if-present typecheck`
4. `pnpm -r --if-present build`
5. `pnpm -r --if-present test`

Superseded runs on the same ref are cancelled. CI is advisory (no branch protection), per the project's no-approval merge policy.

## CD
Both deploy workflows run on push to `main` when relevant paths change, and can be run manually (`workflow_dispatch`). Each has a concurrency group, so a newer deploy cancels an older one. **They skip cleanly (notice, green run) until their secrets are set.**

### Frontend → Vercel (`deploy-frontend.yml`)
Paths: `frontend/**`, `packages/**`, the workflow file, root `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`.
Steps (in `frontend/`): `vercel pull --environment=production` → `vercel build --prod` → `vercel deploy --prebuilt --prod`.

Vercel project setup: **Root Directory = `frontend`**, framework Next.js. Link once locally with `vercel link` to get the org/project ids.

### Backend → Render (`deploy-backend.yml`)
Paths: `backend/**`, `packages/**`, the workflow file, root lockfile/config.
POSTs the Render **Deploy Hook** URL. (A commented-out alternative using the Render API with `RENDER_API_KEY` + `RENDER_SERVICE_ID` is in the file.)

Render Web Service setup (repo root as root directory, Node 20):
- Build command: `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @e2ee/backend exec prisma generate && pnpm --filter @e2ee/backend build`
- Start command: `pnpm --filter @e2ee/backend start` (runs `node dist/server.js`)
- Health check path: `/healthz` (switch to `/readyz` once ARCH-007 adds the DB check)
- Turn **Auto-Deploy off** in Render so deploys are driven only by the hook (avoids double deploys).

## GitHub secrets (Settings → Secrets and variables → Actions)
| Secret | Used by |
|---|---|
| `VERCEL_TOKEN` | deploy-frontend |
| `VERCEL_ORG_ID` | deploy-frontend |
| `VERCEL_PROJECT_ID` | deploy-frontend |
| `RENDER_DEPLOY_HOOK_URL` | deploy-backend |

## Runtime environment variables
Set these in the hosting providers, **never commit them**:
- Vercel (frontend): `NEXT_PUBLIC_*` values (e.g. API / WebSocket base URL).
- Render (backend): `DATABASE_URL`, `SESSION_SECRET`, plus anything else in `.env.example`.

## Auth API (backend, live at https://e2ee-ciphertext-backend.vercel.app)

Username-only accounts; passwords hashed with argon2id (`@node-rs/argon2`, m=19MiB t=2 p=1).
Sessions are opaque 256-bit tokens; only SHA-256 digests are stored (`sessions.token_hash`).

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| POST | /auth/signup | `{username, password}` | 201 `{user, session}` + cookie | 400 validation, 409 `username_taken` |
| POST | /auth/signin | `{username, password}` | 200 `{user, session}` + cookie | 401 `invalid_credentials` |
| POST | /auth/forgot-password | `{username}` | 200 generic message (always) | 400 validation |
| POST | /auth/reset-password | `{token, newPassword}` | 200, revokes all sessions | 400 `invalid_token` |
| POST | /auth/signout | – | 204 | – |
| GET | /auth/me | – | 200 `{user}` | 401 |

Rules: username `^[a-zA-Z0-9_.]{3,32}$`, stored lowercase (case-insensitive unique); password 10–256 chars.
Session TTL 30 days; reset token TTL 30 min, single use.

Auth transport: httpOnly `e2ee_session` cookie (`Secure; SameSite=None`, because the frontend
and API are different `*.vercel.app` sites) — call with `credentials: "include"`. The same token is
also returned in the body and accepted as `Authorization: Bearer <token>`.

CORS: `http://localhost:3000`, `https://<anything>.vercel.app`, plus `CORS_ORIGINS` (comma list).
Tighten to the exact frontend domain once it is fixed — `*.vercel.app` is broad.

### Forgot-password limitation (DEV-ONLY SHIM)
There is no email/SMS delivery and accounts have no address field. When
`AUTH_DEV_RETURN_RESET_TOKEN=true`, `/auth/forgot-password` returns `devResetToken` in the
response for testing. It is set for **Preview only**; never set it in Production. Real delivery
(optional verified email or recovery codes) is a later milestone.

Migrations: `backend/prisma/migrations`; apply with `pnpm --filter @e2ee/backend prisma:deploy`
(use Neon's direct, non-pooler URL).
