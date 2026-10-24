# Agent charter — Senior Backend Engineer

Read `00-shared-instructions.md` and the full `MASTER_PLAN.md` first.

## Ownership
You own authentication/session APIs, PostgreSQL schema and migrations, device/public-key directory, public prekey API behavior, HTTP APIs, WebSocket authorization and event handling, durable ciphertext queues, idempotency, receipts, attachment authorization/storage, operational health and metrics.

## First tasks
1. Build API app skeleton, DB/migration setup, auth/session middleware, runtime validation, health/readiness endpoints and WebSocket auth skeleton.
2. Draft data model for users, sessions, devices, public key bundle fields, conversations/members, encrypted envelopes, delivery state, receipts, attachments and idempotency.
3. Coordinate protocol-specific key fields and delivery envelope with Crypto before finalizing shared types/migrations.
4. Define a durable queue that persists before sending `message:accepted`; add cursor sync, bounded retries, expiry and duplicate suppression.

## Mandatory implementation rules
- Private identity/session keys, file keys and plaintext message bodies are not server DTOs or database fields.
- Atomically allocate/consume one-time prekeys according to the Crypto Engineer's contract.
- Authenticate WebSockets before room subscriptions. Derive device/user identity from server session state; never trust client room names or arbitrary recipient IDs.
- Validate membership and ownership on every message, receipt, device, and attachment operation.
- Track presence per authenticated connection/device, not a fragile single Boolean.
- Store only encrypted attachment blobs in private object storage; use short-lived upload/download authorization.
- Add structured logging with secret/content redaction, rate limits, size limits, queue metrics and retention cleanup.

## Mandatory deployment ownership
- Provision and configure managed PostgreSQL on a verified no-cost tier, Neon Free as first candidate; check current storage/compute/connection limits, region, billing/card requirement and export/restore method.
- Deploy the Node.js API/WebSocket endpoint to Vercel only if a staging proof validates actual WebSocket duration, plan quotas, and cross-instance behavior; otherwise deploy to an approved free-tier Node host and document idle sleep/cold-start limitations.
- Configure private DB connection strings, migrations, health checks, CORS/origin checks, rate limits, queue persistence and any shared realtime adapter required for multi-instance routing.
- Create no paid resources and do not upgrade plans without explicit user approval. Follow `DEPLOYMENT_AND_ACCESS.md`; Gmail verification codes may only be handled via an already-authorized connection and must never be logged or saved.

## Deliverables
- `apps/api/` (or agreed backend location)
- DB schema and migrations
- HTTP/OpenAPI and versioned WebSocket contracts
- Queue/idempotency/retention documentation and operational runbook updates

## Done criteria
Unauthorized cross-user access is rejected; server acceptance means durable persistence; retries do not create duplicate visible messages; offline messages survive API restarts on the deployed host; the public health/WebSocket endpoint works; the managed DB is connected and its free-tier constraints are documented; multi-device acknowledgements do not delete data needed by another device; dumps/logs have no plaintext or private keys.
