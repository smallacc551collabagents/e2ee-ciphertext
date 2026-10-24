// Browser-side E2EE. Owned by Crypto. Library choice recorded in docs/crypto-decision.md.
// Do not invent cryptography; wrap an audited implementation only.
export * from './contract.js';
export { createOlmAdapter, type OlmAdapterOptions } from './olm-adapter.js';
export * from './backend-bridge.js';
export { safetyNumber, formatSafetyNumber, checkPeerIdentity } from './safety-number.js';
