/**
 * Peer identity refresh (E2EE-37). Re-reads a peer's published identity
 * (a) when a message from them fails to decrypt and (b) when the stored
 * check is older than `maxAgeMs` (call `refreshStale` on app start / timer).
 *
 * New keys are NEVER trusted silently: if the published identity differs from
 * the one stored on first use, the result is IDENTITY_CHANGED and the store is
 * left unchanged until the user re-verifies (`acceptNewIdentity`).
 */
import { CryptoError, type CryptoAdapter, type DeviceIdentity, type ReceiveResult } from './contract.js';
import { fromBundle, usernameOf, type BackendHttp } from './backend-bridge.js';
import { checkPeerIdentity } from './safety-number.js';

export interface StoredPeer { readonly identity: DeviceIdentity; readonly checkedAt: number }
/** App-supplied persistence (e.g. IndexedDB). Holds public keys only. */
export interface PeerIdentityStore {
  get(userId: string): Promise<StoredPeer | undefined>;
  set(userId: string, value: StoredPeer): Promise<void>;
}

export type RefreshStatus = 'first-use' | 'unchanged' | 'changed' | 'no-keys';
export interface RefreshResult { readonly userId: string; readonly status: RefreshStatus; readonly error?: CryptoError; readonly current?: DeviceIdentity }

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface PeerVerifierOptions {
  adapter: CryptoAdapter;
  http: BackendHttp;
  store: PeerIdentityStore;
  maxAgeMs?: number;
  now?: () => number;
}

export function createPeerVerifier(o: PeerVerifierOptions) {
  const now = o.now ?? Date.now;
  const maxAge = o.maxAgeMs ?? DAY_MS;

  /** Published identity, decoded (not trusted) from GET /keys/identity. */
  async function published(userId: string): Promise<DeviceIdentity | null> {
    try {
      const raw = (await o.http.request('GET', `/keys/identity/${encodeURIComponent(usernameOf(userId))}`)) as Parameters<typeof fromBundle>[0];
      const d = fromBundle({ ...raw, oneTimePrekey: null }, userId);
      const keys = (d.deviceKeys as { keys?: Record<string, string> }).keys ?? {};
      return { userId, deviceId: d.deviceId, ed25519: keys[`ed25519:${d.deviceId}`] ?? '', curve25519: keys[`curve25519:${d.deviceId}`] ?? '' };
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  }

  async function refresh(userId: string): Promise<RefreshResult> {
    const verified = await o.adapter.refreshPeer(userId);
    const current = await published(userId);
    if (!current) return { userId, status: 'no-keys' };
    const stored = await o.store.get(userId);
    // Published keys the library did not verify (bad signature, or a new key
    // under a known device id) are treated as a change, never as trusted.
    const isVerified = verified.some((v) => v.deviceId === current.deviceId && v.ed25519 === current.ed25519 && v.curve25519 === current.curve25519);
    try {
      checkPeerIdentity(stored?.identity, current);
      if (!isVerified) throw new CryptoError('IDENTITY_CHANGED', 'Published peer keys failed verification');
    } catch (e) {
      if (e instanceof CryptoError && e.code === 'IDENTITY_CHANGED') return { userId, status: 'changed', error: e, current };
      throw e;
    }
    await o.store.set(userId, { identity: stored?.identity ?? current, checkedAt: now() });
    return { userId, status: stored ? 'unchanged' : 'first-use', current };
  }

  return {
    refresh,
    /** (a) Call with adapter.receive() results; refreshes senders of failed messages once each. */
    async onReceiveResults(results: readonly ReceiveResult[]): Promise<RefreshResult[]> {
      const senders = new Set(results.filter((r) => !r.ok).map((r) => (r.ok ? '' : r.envelope.sender.userId)));
      const out: RefreshResult[] = [];
      for (const u of senders) out.push(await refresh(u));
      return out;
    },
    /** (b) Call on app start and on a timer; refreshes peers whose last check is older than maxAgeMs. */
    async refreshStale(userIds: readonly string[]): Promise<RefreshResult[]> {
      const out: RefreshResult[] = [];
      for (const u of userIds) {
        const s = await o.store.get(u);
        if (!s || now() - s.checkedAt >= maxAge) out.push(await refresh(u));
      }
      return out;
    },
    /** Only after the user re-verifies the safety number. */
    async acceptNewIdentity(identity: DeviceIdentity): Promise<void> {
      await o.store.set(identity.userId, { identity, checkedAt: now() });
    },
  };
}
