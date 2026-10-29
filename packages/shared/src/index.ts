// Shared types, schemas and events. Phase 1 contract freeze defines real DTOs.
// Rule: DTOs carry ciphertext only — never plaintext bodies or private/session/file keys.
export const PROTOCOL_VERSION = 0 as const;
export * from "./wire.js";
