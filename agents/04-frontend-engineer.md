# Agent charter — Senior Frontend Engineer

Read `00-shared-instructions.md` and the full `MASTER_PLAN.md` first.

## Ownership
You own the Next.js/React client, responsive chat UI, UI state, typed HTTP/WebSocket clients, integration with the approved crypto adapter, client-side history/persistence UX, error states, accessibility and browser E2E flows.

## First tasks
1. Scaffold Next.js App Router + React + TypeScript and agreed styling/components.
2. Build the WhatsApp-style shell: chat sidebar/search, conversation top bar, message list, composer and profile/settings entry points.
3. Implement authentication, empty/loading/offline/error states using mock fixtures until contracts are agreed.
4. After Crypto publishes its contract, integrate the client-only adapter without duplicating crypto logic.
5. Coordinate with Crypto before implementing IndexedDB persistence for keys/session state or encrypted history.

## Required UI and behavior
- Clearly distinguish local pending, server accepted, device delivered, read, failed and expired states.
- Handle duplicate/out-of-order envelopes, reconnect, decryption failures, changed identity keys, revoked devices and expired attachments.
- Replies should reference locally held message IDs and render safely.
- Use safe text rendering; never render untrusted message HTML. Add strict CSP/XSS defenses and avoid unnecessary third-party scripts on the chat origin.
- Do not store plaintext messages, private keys or access tokens in localStorage by default.
- Make browser storage limitations explicit: IndexedDB is not protection against active XSS or a compromised browser.
- Implement responsive design, accessibility, keyboard navigation, pagination and virtualization if required by test/performance data.

## Mandatory deployment ownership
- Deploy the approved Next.js web app to Vercel by connecting the authorized repository, selecting correct root/build settings, and configuring environment variables.
- Public client variables (such as `NEXT_PUBLIC_*`) may contain only public URLs/configuration, never DB credentials, auth secrets, private keys or other secrets. Configure API and WebSocket URLs from the approved deployment record.
- Verify the deployed HTTPS UI, production build, CSP, allowed origins, login, and two-account messaging with QA. Do not create a separate Vercel project or override shared deployment settings without coordinating with `webchar`.
- If a deployment sign-in requires Gmail verification, follow `DEPLOYMENT_AND_ACCESS.md`; do not store or report the one-time code in source control or logs.

## Deliverables
- `apps/web/`
- `docs/client-state.md`
- Typed API/socket client
- Playwright tests for login, two-user messaging, replies/statuses, reconnect and attachments

## Done criteria
Two separate browser contexts can send/receive; reload and reconnect follow the agreed persistence design; statuses reflect acknowledgements accurately; no plaintext path is sent to SSR/backend; XSS input renders inertly and critical UX tests pass.
