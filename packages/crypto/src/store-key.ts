/**
 * At-rest key for the library's IndexedDB store.
 *
 * A random 32-byte store key is generated with WebCrypto and kept only in
 * wrapped form. The wrapping key is a NON-EXTRACTABLE AES-GCM CryptoKey that
 * is itself persisted in IndexedDB (structured clone keeps it non-extractable),
 * so script cannot export it. The unwrapped store key exists in memory only
 * while the store is open (the library requires raw bytes) — see
 * docs/key-lifecycle.md "Known limitations".
 *
 * The account password is never used here.
 */
import { CryptoError } from './contract.js';

const DB_VERSION = 1;
const OBJECT_STORE = 'keys';
const RECORD = 'store-key-v1';

interface WrappedRecord {
  wrappingKey: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  wrapped: ArrayBuffer;
}

function idb(): IDBFactory {
  const f = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!f) throw new CryptoError('UNSUPPORTED_ENVIRONMENT', 'IndexedDB is not available');
  return f;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function openDb(name: string): Promise<IDBDatabase> {
  const open = idb().open(name, DB_VERSION);
  open.onupgradeneeded = () => {
    if (!open.result.objectStoreNames.contains(OBJECT_STORE)) open.result.createObjectStore(OBJECT_STORE);
  };
  return req(open);
}

/** Returns the raw store key, creating and persisting it (wrapped) on first use. */
export async function getOrCreateStoreKey(dbName: string): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new CryptoError('UNSUPPORTED_ENVIRONMENT', 'WebCrypto is not available');
  try {
    const db = await openDb(dbName);
    try {
      const existing = (await req(db.transaction(OBJECT_STORE).objectStore(OBJECT_STORE).get(RECORD))) as
        | WrappedRecord
        | undefined;
      if (existing) {
        const raw = await subtle.decrypt({ name: 'AES-GCM', iv: existing.iv }, existing.wrappingKey, existing.wrapped);
        return new Uint8Array(raw);
      }
      const wrappingKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const storeKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, storeKey);
      const tx = db.transaction(OBJECT_STORE, 'readwrite');
      // `add` (not `put`) so a concurrent tab cannot silently overwrite an existing key.
      tx.objectStore(OBJECT_STORE).add({ wrappingKey, iv, wrapped } satisfies WrappedRecord, RECORD);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      return storeKey;
    } finally {
      db.close();
    }
  } catch (e) {
    if (e instanceof CryptoError) throw e;
    throw new CryptoError('STORAGE_FAILED', 'Could not load or create the local store key', { cause: e });
  }
}
