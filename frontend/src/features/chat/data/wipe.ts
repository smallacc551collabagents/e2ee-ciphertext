// Deletes every local E2EE store on this browser: the crypto store `<storeName>` and its
// key-wrap store `<storeName>-wrap` (storeName = e2ee-<userId>), plus our plaintext and
// peer-identity caches. packages/crypto exposes no wipe API, so we delete the DBs directly.
export const E2EE_DB_PREFIX = "e2ee-";
export const storeNameFor = (userId: string) => `${E2EE_DB_PREFIX}${userId}`;

function del(name: string): Promise<void> {
  return new Promise((resolve) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}

export async function wipeLocalE2EE(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const dbs = (await indexedDB.databases?.().catch(() => [])) ?? [];
  await Promise.all(dbs.map((d) => d.name).filter((n): n is string => !!n && n.startsWith(E2EE_DB_PREFIX)).map(del));
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k?.startsWith("e2ee.")) localStorage.removeItem(k);
  }
}
