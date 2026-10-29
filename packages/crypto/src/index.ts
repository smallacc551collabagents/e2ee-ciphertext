// Browser-side E2EE. Owned by Crypto. Library choice recorded in docs/crypto-decision.md.
// Do not invent cryptography; wrap an audited implementation only.
export * from './contract.js';
export { createOlmAdapter, type OlmAdapterOptions } from './olm-adapter.js';
export * from './backend-bridge.js';
export { safetyNumber, formatSafetyNumber, checkPeerIdentity } from './safety-number.js';
export * from './peer-trust.js';
export { toDisplayText, DISPLAY_MAX_CHARS } from './display.js';
export * from './history-store.js';
export * from './attachments.js';
export * from './revocation.js';
export * from './groups.js';
export * from './device-state.js';
