/**
 * Safety numbers and identity-change detection (E2EE-37 primitives).
 * Uses the Signal "numeric fingerprint" construction (iterated SHA-512 over
 * version || public identity key || stable id), computed with WebCrypto.
 * No new cryptography: only a standard hash, for human comparison.
 */
import { CryptoError, type DeviceIdentity } from './contract.js';
import { fromB64 } from './backend-bridge.js';

const ITERATIONS = 5200;
const te = new TextEncoder();

async function fingerprint(identityKeyB64: string, stableId: string): Promise<string> {
  const key = fromB64(identityKeyB64);
  const id = te.encode(stableId);
  let hash: Uint8Array = new Uint8Array([0, 0, ...key, ...id]);
  for (let i = 0; i < ITERATIONS; i++) {
    hash = new Uint8Array(await crypto.subtle.digest('SHA-512', new Uint8Array([...hash, ...key])));
  }
  let out = '';
  for (let c = 0; c < 6; c++) {
    let n = 0;
    for (let j = 0; j < 5; j++) n = n * 256 + hash[c * 5 + j]!;
    out += String(n % 100000).padStart(5, '0');
  }
  return out;
}

/** 60-digit safety number; identical on both sides regardless of who computes it. */
export async function safetyNumber(a: DeviceIdentity, b: DeviceIdentity): Promise<string> {
  const fa = await fingerprint(a.ed25519, a.userId);
  const fb = await fingerprint(b.ed25519, b.userId);
  return fa < fb ? fa + fb : fb + fa;
}

/** Split for display: 12 groups of 5 digits. */
export const formatSafetyNumber = (n: string): string[] => n.match(/\d{5}/g) ?? [];

/**
 * Compare a peer's current published identity against the one stored when
 * first seen (trust on first use). Returns the identity to store, or throws
 * IDENTITY_CHANGED so the UI can show the "safety number changed" banner.
 */
export function checkPeerIdentity(stored: DeviceIdentity | undefined, current: DeviceIdentity): DeviceIdentity {
  if (!current.ed25519 || !current.curve25519) throw new CryptoError('NO_DEVICE', 'Peer has no published identity');
  if (stored && (stored.ed25519 !== current.ed25519 || stored.curve25519 !== current.curve25519 || stored.deviceId !== current.deviceId)) {
    throw new CryptoError('IDENTITY_CHANGED', 'Peer identity key changed');
  }
  return current;
}
