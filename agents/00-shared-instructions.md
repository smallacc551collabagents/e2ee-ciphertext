# Shared instructions for every E2EE Web Chat agent

Read `MASTER_PLAN.md`, `EXECUTION_SCHEDULE.md`, `DEPLOYMENT_AND_ACCESS.md`, and your role-specific charter before making implementation changes. `MASTER_PLAN.md` is the technical source of truth; `EXECUTION_SCHEDULE.md` determines start gates, dependencies, allowed parallel work, independent review triggers, and conflict resolution. The System Architecture Supervisor & Integration Auditor is an independent reviewer, not a second overall architect.

## Non-negotiable rules
- Keep message plaintext and file encryption keys on authorized client devices only. Backend stores/routes ciphertext and required metadata only.
- Do not invent cryptography. Use an approved, maintained protocol implementation and wait for the Crypto Engineer's documented feasibility decision before depending on crypto APIs.
- Do not create independent or conflicting versions of shared APIs, socket events, database schemas, payload types, or state machines. Cooperate with evidence-based findings from the System Architecture Supervisor and fix findings in the owning module; the Supervisor must not silently overwrite another agent’s active work. Coordinate with the module owner and update the shared contracts. Follow `EXECUTION_SCHEDULE.md`; never bypass a phase gate or guess an interface to keep moving.
- Do not add server-side AI, RAG, embeddings, plaintext analytics, or plaintext moderation to the MVP.
- Do not log plaintext, keys, session secrets, cookies, bearer tokens, or file keys.
- Do not report a feature as complete unless you state what was implemented and which tests actually passed. At each handoff, report status (`Done`, `In progress`, `Blocked`, or `Ready for review`) and the next acceptance gate.

## Required end-of-task report
1. Owned scope and files changed.
2. Implementation completed.
3. Contracts/types/events/endpoints/migrations introduced or changed.
4. Tests run and actual outcomes.
5. Security/privacy implications and remaining risks.
6. Blockers, exact decision needed, responsible owner and recommendation.
7. Next small tasks and acceptance criteria.
8. Explicitly list what is not done.


## Required hosting and deployment
- This project must be deployed, not merely documented. Frontend target is Vercel. Backend should use Vercel if the actual WebSocket route/connection duration/plan limits and cross-instance design pass a staging test; otherwise choose a suitable free-tier Node host and record its limitations. Provision a managed PostgreSQL free-tier database (Neon Free is the first candidate, subject to current terms); keep the DB connection string private.
- Do not assume any provider remains free or permits production use forever. Verify the provider's current plan, limits, idle behavior, storage, billing and card requirements before creating resources. Never enable paid services or upgrades without explicit user approval.
- Follow the step-by-step, Gmail-code and deployment safety rules in `DEPLOYMENT_AND_ACCESS.md`.


## Independent architecture review
- The System Architecture Supervisor reviews contract changes, security-sensitive pull requests, phase gates, and staging/release evidence when activated by the repository/task workflow or explicitly invoked.
- No agent may claim the Supervisor continuously monitored changes unless repository/CI/event hooks were configured and accessible.
- Findings must include evidence, severity, accountable owner, required correction, regression test, target gate, and residual risk. `webchar` remains overall integration lead; Crypto owns cryptographic correctness; `testing bot` independently verifies fixes.
- Never give the Supervisor broad authority to force-push, delete work, overwrite another active branch, change production settings, or access unrelated accounts.
