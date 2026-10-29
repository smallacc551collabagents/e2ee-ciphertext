// Local crypto wipe on sign-out / session expiry. Uses crypto's deleteLocalCryptoState
// (<storeName> Olm store, <storeName>-wrap, <storeName>-history) for every user that used
// this browser, then our public-key peer cache and device-id keys.
export const E2EE_DB_PREFIX = "e2ee-";
export const storeNameFor = (userId: string) => `${E2EE_DB_PREFIX}${userId}`;
const DEVICE_KEY = "e2ee.deviceId.";

type Deleter = (storeName: string) => Promise<void>;
const closers = new Set<() => void>();
/** Register a close() for open stores; open connections block deletion. */
export function onWipe(close: () => void): () => void { closers.add(close); return () => closers.delete(close); }

function del(name: string): Promise<void> {
  return new Promise((resolve) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}

export async function wipeLocalE2EE(deleteState?: Deleter): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  closers.forEach((c) => { try { c(); } catch { /* ignore */ } });
  closers.clear();
  const dl = deleteState ?? (await import("@e2ee/crypto")).deleteLocalCryptoState;
  const users = new Set<string>();
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(DEVICE_KEY)) users.add(k.slice(DEVICE_KEY.length));
  }
  await Promise.all([...users].map(async (u) => {
    const s = storeNameFor(u);
    await dl(s).catch(() => undefined);
    await del(`${s}-peers`);
  }));
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k?.startsWith("e2ee.")) localStorage.removeItem(k);
  }
}

/** Normal sign-out / session expiry: close open stores but KEEP this browser's keys and history,
 *  so signing back in here resumes the same device (no new-device screen). Use wipeLocalE2EE only
 *  for account delete or an explicit "remove this browser's data". */
export async function closeLocalE2EE(): Promise<void> {
  closers.forEach((c) => { try { c(); } catch { /* ignore */ } });
  closers.clear();
  // Also release the Olm machine for every account used in this tab (keys stay on disk).
  const { closeCryptoSession } = await import("@e2ee/crypto").catch(() => ({ closeCryptoSession: undefined }));
  closeCryptoSession?.();
}
