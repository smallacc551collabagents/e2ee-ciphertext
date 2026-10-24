// Tiny IndexedDB key-value store (browser only). Holds decrypted plaintext and peer
// public identities on this device; nothing here is ever sent to the server.
export interface Kv<T> { get(k: string): Promise<T | undefined>; set(k: string, v: T): Promise<void> }

export function idbKv<T>(dbName: string, store = "kv"): Kv<T> {
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(dbName, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(store);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const tx = async <R>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<R>) => {
    const s = (await db).transaction(store, mode).objectStore(store);
    return new Promise<R>((res, rej) => { const q = fn(s); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  };
  return {
    get: (k) => tx("readonly", (s) => s.get(k) as IDBRequest<T | undefined>),
    set: async (k, v) => { await tx("readwrite", (s) => s.put(v, k)); },
  };
}
