/**
 * Decrypted message history at rest (encrypted IndexedDB).
 *
 * Each record is AES-256-GCM encrypted under a key derived with HKDF-SHA-256 from
 * this store's own random 32-byte base key. The base key is imported as a
 * NON-EXTRACTABLE HKDF CryptoKey and persisted via structured clone, so script
 * cannot export it. The AAD binds (conversationId, seq), so a ciphertext moved to
 * another slot or conversation fails to decrypt. A fresh 96-bit IV is used per record.
 *
 * Plaintext never appears in IndexedDB keys or values; only conversationId and seq
 * (both already visible to the server) are stored in clear for indexing.
 */
import { CryptoError } from './contract.js';

export interface HistoryMessage {
  /** Server message id. */
  readonly id: string;
  readonly senderUserId: string;
  readonly senderDeviceId: string;
  /** Decrypted plaintext. */
  readonly text: string;
  /** ISO time from the server. */
  readonly sentAt: string;
  readonly clientMsgId?: string;
}

export interface HistoryEntry extends HistoryMessage {
  readonly conversationId: string;
  readonly seq: string;
}

export interface HistoryStore {
  put(conversationId: string, seq: string | bigint, msg: HistoryMessage): Promise<void>;
  /** Entries with seq > afterSeq (default: all), ascending by seq. */
  list(conversationId: string, afterSeq?: string | bigint, limit?: number): Promise<HistoryEntry[]>;
  /** Highest stored seq for the conversation, or null. Use as the `after` cursor. */
  lastSeq(conversationId: string): Promise<string | null>;
  /** Removes all history records (keeps the key). */
  clear(): Promise<void>;
  close(): void;
}

const DB_VERSION = 1;
const KEYS = 'keys';
const MSGS = 'messages';
const KEY_RECORD = 'history-key-v1';
const HKDF_INFO = new TextEncoder().encode('e2ee-history-v1 aes-256-gcm');
const SEQ_WIDTH = 20; // fits uint64; zero-padded so string order == numeric order

interface Row { conversationId: string; seq: string; iv: Uint8Array<ArrayBuffer>; ct: ArrayBuffer }

export const historyDbName = (storeName: string) => `${storeName}-history`;

function idb(): IDBFactory {
  const f = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!f) throw new CryptoError('UNSUPPORTED_ENVIRONMENT', 'IndexedDB is not available');
  return f;
}
const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

function seqKey(seq: string | bigint): string {
  const s = typeof seq === 'bigint' ? seq.toString() : seq;
  if (!/^\d{1,20}$/.test(s) || BigInt(s) > 0xffffffffffffffffn) throw new CryptoError('INVALID_ENVELOPE', 'Invalid seq');
  return s.padStart(SEQ_WIDTH, '0');
}
const unpad = (s: string) => s.replace(/^0+(?=\d)/, '');
const aad = (conversationId: string, seq: string) => new TextEncoder().encode(JSON.stringify(['e2ee-history-v1', conversationId, seq]));

export async function openHistoryStore(storeName: string): Promise<HistoryStore> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new CryptoError('UNSUPPORTED_ENVIRONMENT', 'WebCrypto is not available');
  let db: IDBDatabase;
  let key: CryptoKey;
  try {
    const open = idb().open(historyDbName(storeName), DB_VERSION);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(KEYS);
      open.result.createObjectStore(MSGS, { keyPath: ['conversationId', 'seq'] });
    };
    db = await req(open);
    let base = (await req(db.transaction(KEYS).objectStore(KEYS).get(KEY_RECORD))) as CryptoKey | undefined;
    if (!base) {
      const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
      const created = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
      raw.fill(0);
      const tx = db.transaction(KEYS, 'readwrite');
      tx.objectStore(KEYS).add(created, KEY_RECORD); // `add`: a racing tab can't overwrite
      try { await done(tx); base = created; } catch {
        base = (await req(db.transaction(KEYS).objectStore(KEYS).get(KEY_RECORD))) as CryptoKey;
      }
    }
    key = await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: HKDF_INFO },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
  } catch (e) {
    if (e instanceof CryptoError) throw e;
    throw new CryptoError('STORAGE_FAILED', 'Could not open the history store', { cause: e });
  }
  let closed = false;
  const guard = () => { if (closed) throw new CryptoError('NOT_INITIALIZED', 'History store is closed'); };

  return {
    async put(conversationId, seq, msg) {
      guard();
      const s = seqKey(seq);
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const body: HistoryMessage = { id: msg.id, senderUserId: msg.senderUserId, senderDeviceId: msg.senderDeviceId, text: msg.text, sentAt: msg.sentAt, ...(msg.clientMsgId ? { clientMsgId: msg.clientMsgId } : {}) };
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(conversationId, s) }, key, new TextEncoder().encode(JSON.stringify(body)));
      const tx = db.transaction(MSGS, 'readwrite');
      tx.objectStore(MSGS).put({ conversationId, seq: s, iv, ct } satisfies Row);
      await done(tx);
    },
    async list(conversationId, afterSeq, limit = 1000) {
      guard();
      const lower = afterSeq === undefined ? [conversationId, ''] : [conversationId, seqKey(afterSeq)];
      const range = IDBKeyRange.bound(lower, [conversationId, '\uffff'], afterSeq !== undefined, false);
      const rows = (await req(db.transaction(MSGS).objectStore(MSGS).getAll(range, limit))) as Row[];
      const out: HistoryEntry[] = [];
      for (const r of rows) {
        let pt: ArrayBuffer;
        try {
          pt = await subtle.decrypt({ name: 'AES-GCM', iv: r.iv, additionalData: aad(conversationId, r.seq) }, key, r.ct);
        } catch (e) {
          throw new CryptoError('DECRYPT_FAILED', 'History record failed authentication', { cause: e });
        }
        out.push({ ...(JSON.parse(new TextDecoder().decode(pt)) as HistoryMessage), conversationId, seq: unpad(r.seq) });
      }
      return out;
    },
    async lastSeq(conversationId) {
      guard();
      const range = IDBKeyRange.bound([conversationId, ''], [conversationId, '\uffff']);
      const cur = await req(db.transaction(MSGS).objectStore(MSGS).openCursor(range, 'prev'));
      return cur ? unpad((cur.value as Row).seq) : null;
    },
    async clear() {
      guard();
      const tx = db.transaction(MSGS, 'readwrite');
      tx.objectStore(MSGS).clear();
      await done(tx);
    },
    close() { closed = true; db.close(); },
  };
}

/**
 * Logout: delete every local crypto database for this device (Olm store, its wrapping
 * key, and message history). Close adapters/stores first; open connections block deletion.
 */
export async function deleteLocalCryptoState(storeName: string): Promise<void> {
  const names = [`${storeName}::matrix-sdk-crypto`, `${storeName}::matrix-sdk-crypto-meta`, `${storeName}-wrap`, historyDbName(storeName)];
  await Promise.all(names.map((n) => new Promise<void>((res, rej) => {
    const r = idb().deleteDatabase(n);
    r.onsuccess = () => res();
    r.onerror = () => rej(new CryptoError('STORAGE_FAILED', 'Could not delete local crypto state', { cause: r.error }));
    r.onblocked = () => rej(new CryptoError('STORAGE_FAILED', 'Local crypto state is still open in another tab'));
  })));
}
