// Decrypted-history persistence seam. NEVER implement this with plaintext IndexedDB or
// localStorage. Target: packages/crypto historyStore (AES-GCM under the wrapped store key)
// once it merges. Until then the only implementation is in-memory (lost on reload).
export interface HistoryStore {
  get(messageId: string): Promise<string | undefined>;
  set(messageId: string, text: string): Promise<void>;
}

export function memoryHistoryStore(): HistoryStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); } };
}
