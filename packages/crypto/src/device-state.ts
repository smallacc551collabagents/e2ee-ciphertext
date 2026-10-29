/**
 * New-device detection (E2EE-79).
 *
 * MVP is one device per account. When a browser has no local keystore but the server already
 * publishes an identity for the account, opening the adapter would silently publish a NEW identity
 * (replacing the old device). Callers must instead check `localDeviceState()` first and only open the
 * adapter after the user explicitly confirms that this browser becomes the new device.
 * The old browser's local keys are never touched by this module.
 */
import { CryptoError, type DeviceIdentity } from './contract.js';
import type { BackendHttp } from './backend-bridge.js';

/** fresh: no server identity yet; existing: this browser holds the keys; needs-new-device-confirmation: server has an identity, this browser has none. */
export type LocalDeviceState = 'fresh' | 'existing' | 'needs-new-device-confirmation';

const WRAP_STORE = 'keys';
const WRAP_RECORD = 'store-key-v1';

/** True if this browser already holds a wrapped store key for `storeName` (i.e. a local keystore). Read-only. */
export async function hasLocalKeystore(storeName: string): Promise<boolean> {
  const f = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!f) throw new CryptoError('UNSUPPORTED_ENVIRONMENT', 'IndexedDB is not available');
  const name = `${storeName}-wrap`;
  if (typeof f.databases === 'function') {
    const dbs = await f.databases();
    if (!dbs.some((d) => d.name === name)) return false;
  }
  return new Promise<boolean>((resolve, reject) => {
    const open = f.open(name);
    let created = false;
    open.onupgradeneeded = () => { created = true; };
    open.onerror = () => reject(new CryptoError('STORAGE_FAILED', 'Could not read the local keystore', { cause: open.error }));
    open.onsuccess = () => {
      const db = open.result;
      const done = (v: boolean) => {
        db.close();
        if (created) f.deleteDatabase(name); // leave no trace of the probe
        resolve(v);
      };
      if (!db.objectStoreNames.contains(WRAP_STORE)) return done(false);
      const r = db.transaction(WRAP_STORE).objectStore(WRAP_STORE).count(WRAP_RECORD);
      r.onsuccess = () => done(r.result > 0);
      r.onerror = () => done(false);
    };
  });
}

/** True if the server publishes an identity for `username` (GET /keys/identity/:username; 404 = none). */
export async function serverHasIdentity(http: BackendHttp, username: string): Promise<boolean> {
  try {
    await http.request('GET', `/keys/identity/${encodeURIComponent(username)}`);
    return true;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return false;
    throw new CryptoError('TRANSPORT_FAILED', 'Could not check the published identity', { cause: e });
  }
}

/** Decide whether opening the adapter is safe or needs the user's "use this browser as my new device" confirmation. */
export async function localDeviceState(o: { http: BackendHttp; username: string; storeName: string }): Promise<LocalDeviceState> {
  if (await hasLocalKeystore(o.storeName)) return 'existing';
  return (await serverHasIdentity(o.http, o.username)) ? 'needs-new-device-confirmation' : 'fresh';
}

/** How a peer's published identity changed. 'new-device': a different deviceId (peer signed in on a new browser); 'key-changed': same deviceId, different keys (unexpected). */
export type IdentityChangeKind = 'new-device' | 'key-changed';

export function classifyIdentityChange(previous: DeviceIdentity | undefined, current: DeviceIdentity): IdentityChangeKind {
  return previous && previous.deviceId !== current.deviceId ? 'new-device' : 'key-changed';
}
