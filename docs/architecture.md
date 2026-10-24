# Architecture

Owner: System Architecture/Supervisor.

## Decisions
- **Layout:** `frontend/`, `backend/`, `packages/crypto`, `packages/shared` per Mustafa. This differs from MASTER_PLAN's `apps/*` names; Mustafa's layout wins.
- **ORM:** Prisma (PostgreSQL) for the backend schema and migrations.
- **HTTP server:** Fastify.
