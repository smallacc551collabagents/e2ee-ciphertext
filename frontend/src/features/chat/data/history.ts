// Decrypted history at rest = packages/crypto historyStore (AES-256-GCM, non-extractable key).
// NEVER persist plaintext via IndexedDB/localStorage directly.
export type { HistoryStore, HistoryEntry, HistoryMessage } from "@e2ee/crypto";
