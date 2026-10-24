import { createIdentityGate, type IdentityGate, type StoredPeer } from '../src/index.js';

/** In-memory identity gate for tests (real gate logic, memory-backed store). */
export function memGate(): IdentityGate {
  const mem = new Map<string, StoredPeer>();
  return createIdentityGate({ get: async (u) => mem.get(u), set: async (u, v) => void mem.set(u, v) });
}
