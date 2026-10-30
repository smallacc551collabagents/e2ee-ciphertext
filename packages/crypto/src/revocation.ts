/**
 * Device revocation enforcement on the sending side (E2EE-50). See docs/key-lifecycle.md.
 *
 * Model: one active device (identity) per user. A device is revoked when its owner
 * publishes a new identity (re-install / recovery on a new device) or the server stops
 * publishing any identity for the user (account/device removal). `withRevocationCheck`
 * wraps the IdentityGate used by `createOlmAdapter.encrypt` so that, before encrypting,
 * the target device is confirmed to still be the one published by GET /keys/identity
 * (cached for at most `maxAgeMs`). A device that is no longer published never receives
 * new ciphertext from an honest client, even if an Olm session with it already exists.
 */
import { CryptoError, type DeviceIdentity } from './contract.js';
import { fetchIdentities, fromBundle, usernameOf, type BackendHttp } from './backend-bridge.js';
import type { IdentityGate, PeerIdentityStore } from './peer-trust.js';

/** Default freshness window for the published-identity check. */
export const REVOCATION_CHECK_MS = 5 * 60 * 1000;

export interface RevocationCheckOptions {
  http: BackendHttp;
  /** Same store as the gate/verifier: a changed identity is recorded as pendingChange. */
  store: PeerIdentityStore;
  maxAgeMs?: number;
  now?: () => number;
}

const same = (a: DeviceIdentity, b: DeviceIdentity) =>
  a.userId === b.userId && a.deviceId === b.deviceId && a.ed25519 === b.ed25519 && a.curve25519 === b.curve25519;

export function withRevocationCheck(inner: IdentityGate, o: RevocationCheckOptions): IdentityGate {
  const now = o.now ?? Date.now;
  const maxAge = o.maxAgeMs ?? REVOCATION_CHECK_MS;
  const fresh = new Map<string, { id: DeviceIdentity; at: number }>();
  const primed = new Set<string>(); // fetched by prime() for the operation in progress; counts as fresh once

  async function published(userId: string): Promise<DeviceIdentity | null> {
    let raw: unknown;
    try {
      raw = await o.http.request('GET', `/keys/identity/${encodeURIComponent(usernameOf(userId))}`);
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      // Fail closed: if we cannot confirm the device is still current, do not send.
      throw new CryptoError('TRANSPORT_FAILED', 'Could not confirm peer device is still published', { cause: e });
    }
    return decode(raw, userId);
  }
  function decode(raw: unknown, userId: string): DeviceIdentity {
    const d = fromBundle({ ...(raw as Parameters<typeof fromBundle>[0]), oneTimePrekey: null }, userId);
    const keys = (d.deviceKeys as { keys?: Record<string, string> }).keys ?? {};
    return { userId, deviceId: d.deviceId, ed25519: keys[`ed25519:${d.deviceId}`] ?? '', curve25519: keys[`curve25519:${d.deviceId}`] ?? '' };
  }

  return {
    assertUserNotPending: (u) => inner.assertUserNotPending(u),
    /** Batch-refresh stale entries (one request for a whole group). Only fills the freshness cache with what the
     * server publishes; assertTrusted() still compares it to the exact peer device and records changes. */
    async prime(userIds) {
      const stale = [...new Set(userIds)].filter((u) => { const c = fresh.get(u); return !c || now() - c.at >= maxAge; });
      if (!stale.length) return;
      let raw: Map<string, unknown>;
      try { raw = await fetchIdentities(o.http, stale.map(usernameOf)); } catch { return; } // assertTrusted fails closed itself
      for (const u of stale) {
        const r = raw.get(usernameOf(u));
        if (!r) continue;
        try { fresh.set(u, { id: decode(r, u), at: now() }); primed.add(u); } catch { /* malformed: leave stale, assertTrusted re-fetches */ }
      }
      await inner.prime?.(userIds);
    },
    async assertTrusted(peer) {
      const c = fresh.get(peer.userId);
      const live = primed.delete(peer.userId);
      if (!c || (!live && now() - c.at >= maxAge) || !same(c.id, peer)) {
        fresh.delete(peer.userId);
        const cur = await published(peer.userId);
        if (!cur) throw new CryptoError('NO_DEVICE', 'Peer device is revoked (no published identity)');
        if (!same(cur, peer)) {
          const s = await o.store.get(peer.userId);
          if (s) await o.store.set(peer.userId, { ...s, pendingChange: cur });
          throw new CryptoError('IDENTITY_CHANGED', 'Peer device was replaced; re-verify the safety number first');
        }
        fresh.set(peer.userId, { id: cur, at: now() });
      }
      await inner.assertTrusted(peer);
    },
  };
}
