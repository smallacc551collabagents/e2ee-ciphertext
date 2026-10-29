/**
 * Crypto session lifecycle (logout without losing the device).
 *
 * Normal logout must NOT delete the keystore: the Olm store, its non-extractable wrap key and the
 * encrypted history stay in IndexedDB so the same user logging back in on this browser reopens them
 * (state 'existing', no new-device screen). `closeCryptoSession()` only releases every open handle
 * (adapters, history stores) held in this tab. `deleteLocalCryptoState()` remains the full wipe
 * ("log out and remove this device", account delete).
 *
 * Keystores are namespaced per account: use `keystoreNameFor(userId)` so two accounts on one browser
 * never share or overwrite each other's databases.
 */
import { CryptoError } from './contract.js';

export const KEYSTORE_PREFIX = 'e2ee-';

/** Per-account store name (`e2ee-<userId>`). Same scheme the frontend already uses; rejects ids that could collide. */
export function keystoreNameFor(userId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new CryptoError('INVALID_OPTIONS', 'Invalid user id for keystore name');
  return `${KEYSTORE_PREFIX}${userId}`;
}

const open = new Map<string, Set<() => void>>();

/** Internal: register a close() for an open handle on `storeName`. Returns an unregister function. */
export function trackOpen(storeName: string, close: () => void): () => void {
  let s = open.get(storeName);
  if (!s) open.set(storeName, (s = new Set()));
  s.add(close);
  return () => { s!.delete(close); if (!s!.size) open.delete(storeName); };
}

/** Store names with open handles in this tab (diagnostics/tests). */
export function openCryptoSessions(): string[] { return [...open.keys()]; }

/**
 * Logout: close every open adapter/history store (optionally only for one store), keeping all local
 * key material and encrypted history on disk. Idempotent. Never deletes anything.
 */
export function closeCryptoSession(storeName?: string): void {
  const names = storeName === undefined ? [...open.keys()] : [storeName];
  for (const n of names) {
    const s = open.get(n);
    if (!s) continue;
    for (const c of [...s]) { try { c(); } catch { /* already closed */ } }
    open.delete(n);
  }
}
