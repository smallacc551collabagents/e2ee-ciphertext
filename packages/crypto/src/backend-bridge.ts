/**
 * Mapping layer between the adapter's library requests and the Phase 1
 * backend transport (docs/phase1-backend.md, PR #13). The backend stays a
 * dumb store of `bytes + version`; the byte formats below are owned here.
 *
 * Wire format version 1 (all bytes are UTF-8 JSON, base64 on the wire):
 * - identityKey.publicKey   = the library's self-signed device-keys object
 *                             (curve25519 + ed25519, signed by ed25519).
 * - signedPrekey.publicKey  = the signed fallback key object {key, fallback, signatures}
 *   signedPrekey.signature  = raw 64-byte ed25519 signature over it.
 *   signedPrekey.keyId      = numeric id derived from the library key id.
 * - oneTimePrekeys[].publicKey = {id, key: <signed OTK object>}; keyId derived from id.
 * - message ciphertext     = the CiphertextEnvelope JSON (recipient device + Olm message).
 *
 * Signatures are NOT trusted here: the library verifies the device-keys
 * self-signature and each claimed key's signature before building a session.
 * This layer only checks that decoded objects belong to the requested user.
 */
import { CryptoError, type CiphertextEnvelope, type KeyServerTransport, type ServerRequest } from './contract.js';

export const WIRE_VERSION = 1;
export const LIMITS = { keyBytes: 1024, ciphertextBytes: 32 * 1024, prekeyBatch: 100 } as const;
const ALGO = 'signed_curve25519';

/** Minimal authenticated JSON client supplied by the app (cookie session). */
export interface BackendHttp {
  /** Resolve with parsed JSON; reject with an error carrying `status` on non-2xx. */
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown>;
}

// ---- identifiers: library user ids are @username:<domain> ----
export const USER_DOMAIN = 'e2ee.local';
export const userIdFor = (username: string): string => `@${username.toLowerCase()}:${USER_DOMAIN}`;
export function usernameOf(userId: string): string {
  const m = /^@([^:]+):(.+)$/.exec(userId);
  if (!m || m[2] !== USER_DOMAIN) throw new CryptoError('INVALID_ENVELOPE', 'Unknown user id format');
  return m[1]!;
}

// ---- base64 helpers (canonical, padded) ----
const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });
export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function fromB64(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? s : s + '='.repeat(4 - (s.length % 4));
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const jsonToB64 = (v: unknown, max: number): string => {
  const b = te.encode(JSON.stringify(v));
  if (b.length > max) throw new CryptoError('INVALID_ENVELOPE', 'Encoded value exceeds backend size cap');
  return toB64(b);
};
function b64ToJson<T>(s: string): T {
  try {
    return JSON.parse(td.decode(fromB64(s))) as T;
  } catch (e) {
    throw new CryptoError('INVALID_ENVELOPE', 'Malformed key or envelope bytes', { cause: e });
  }
}

/**
 * Stable 31-bit numeric keyId from the library key id ("signed_curve25519:<b64 counter>").
 * The counter is monotonic per device, so ids are unique per user identity.
 */
export function keyIdOf(libraryKeyId: string): number {
  const suffix = libraryKeyId.split(':')[1] ?? '';
  let n = 0;
  for (const b of fromB64(suffix)) n = (n * 256 + b) % 2147483648;
  return n;
}

type Json = Record<string, unknown>;
interface SignedKey { key: string; fallback?: boolean; signatures: Record<string, Record<string, string>> }
interface Bundle {
  userId: string;
  username: string;
  identityKey: { publicKey: string; version: number };
  signedPrekey: { keyId: number; publicKey: string; signature: string; version: number };
  oneTimePrekey: { keyId: number; publicKey: string; version: number } | null;
}

function edSig(obj: SignedKey, userId: string): string {
  const s = Object.values(obj.signatures?.[userId] ?? {})[0];
  if (!s) throw new CryptoError('INVALID_ENVELOPE', 'Key is not signed');
  return s;
}

/** Map a library keys.upload body to POST /keys/publish bodies (batched by cap). */
export function toPublishBodies(uploadBody: string, userId: string): Json[] {
  const b = JSON.parse(uploadBody) as { device_keys?: Json; one_time_keys?: Record<string, SignedKey>; fallback_keys?: Record<string, SignedKey> };
  const first: Json = {};
  if (b.device_keys) first.identityKey = { publicKey: jsonToB64(b.device_keys, LIMITS.keyBytes), version: WIRE_VERSION };
  const fb = Object.entries(b.fallback_keys ?? {})[0];
  if (fb) {
    const [id, obj] = fb;
    first.signedPrekey = {
      keyId: keyIdOf(id),
      publicKey: jsonToB64({ id, key: obj }, LIMITS.keyBytes),
      signature: toB64(fromB64(edSig(obj, userId))),
      version: WIRE_VERSION,
    };
  }
  if (first.identityKey && !first.signedPrekey) {
    throw new CryptoError('TRANSPORT_FAILED', 'Identity publish requires a signed prekey in the same upload');
  }
  const otks = Object.entries(b.one_time_keys ?? {}).map(([id, obj]) => ({
    keyId: keyIdOf(id),
    publicKey: jsonToB64({ id, key: obj }, LIMITS.keyBytes),
    version: WIRE_VERSION,
  }));
  const out: Json[] = [];
  let i = 0;
  do {
    const body: Json = out.length === 0 ? { ...first } : {};
    const batch = otks.slice(i, i + LIMITS.prekeyBatch);
    if (batch.length) body.oneTimePrekeys = batch;
    i += LIMITS.prekeyBatch;
    if (Object.keys(body).length) out.push(body);
  } while (i < otks.length);
  return out;
}

/** Decode a /keys/bundle response into library shapes, checking ownership. */
export function fromBundle(bundle: Bundle, expectedUserId: string) {
  if (bundle.identityKey.version !== WIRE_VERSION || bundle.signedPrekey.version !== WIRE_VERSION) {
    throw new CryptoError('INVALID_ENVELOPE', 'Unsupported key bundle version');
  }
  const deviceKeys = b64ToJson<{ user_id?: string; device_id?: string }>(bundle.identityKey.publicKey);
  if (deviceKeys.user_id !== expectedUserId || typeof deviceKeys.device_id !== 'string') {
    throw new CryptoError('IDENTITY_CHANGED', 'Bundle identity does not belong to the requested user');
  }
  const spk = b64ToJson<{ id: string; key: SignedKey }>(bundle.signedPrekey.publicKey);
  if (toB64(fromB64(edSig(spk.key, expectedUserId))) !== bundle.signedPrekey.signature) {
    throw new CryptoError('INVALID_ENVELOPE', 'Signed prekey signature mismatch');
  }
  let oneTime: { id: string; key: SignedKey } | null = null;
  if (bundle.oneTimePrekey) {
    if (bundle.oneTimePrekey.version !== WIRE_VERSION) throw new CryptoError('INVALID_ENVELOPE', 'Unsupported prekey version');
    oneTime = b64ToJson(bundle.oneTimePrekey.publicKey);
  }
  return { deviceId: deviceKeys.device_id, deviceKeys: deviceKeys as Json, signedPrekey: spk, oneTime };
}

/** http clients whose server answered 404 to POST /keys/identity/batch (pre-deploy backend). */
const noBatch = new WeakSet<BackendHttp>();

/**
 * Published identities (GET /keys/identity bodies) for many users in ONE request: POST /keys/identity/batch
 * {usernames}. Falls back to deduped parallel GETs while the server lacks the batch route (404). Missing users map
 * to null. Values are untrusted wire data; callers verify them (fromBundle + library signature check + gate).
 */
export async function fetchIdentities(http: BackendHttp, usernames: readonly string[]): Promise<Map<string, unknown>> {
  const names = [...new Set(usernames)];
  const out = new Map<string, unknown>(names.map((n) => [n, null]));
  if (!names.length) return out;
  if (!noBatch.has(http)) {
    try {
      for (let i = 0; i < names.length; i += 100) {
        const r = (await http.request('POST', '/keys/identity/batch', { usernames: names.slice(i, i + 100) })) as
          { identities?: unknown } | null;
        const ids = r?.identities;
        const rows: [string, unknown][] = Array.isArray(ids)
          ? (ids as { username?: string }[]).map((x) => [String(x?.username ?? ''), x])
          : Object.entries((ids ?? {}) as Record<string, unknown>);
        for (const [n, v] of rows) if (out.has(n)) out.set(n, v ?? null); // ignore names we did not ask for
      }
      return out;
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
      noBatch.add(http);
    }
  }
  await Promise.all(names.map(async (n) => {
    try { out.set(n, await http.request('GET', `/keys/identity/${encodeURIComponent(n)}`)); } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
    }
  }));
  return out;
}

/** A KeyServerTransport that speaks the Phase 1 backend API. */
/** Stop topping up one-time prekeys once the server holds this many unused. */
export const OTK_POOL_TARGET = 100;

export function createBackendTransport(http: BackendHttp): KeyServerTransport {
  // keys.query -> non-consuming GET /keys/identity; keys.claim -> GET /keys/bundle (consumes one OTK).
  async function fetchKeys(userId: string, consume: boolean) {
    const path = `/keys/${consume ? 'bundle' : 'identity'}/${encodeURIComponent(usernameOf(userId))}`;
    try {
      const raw = (await http.request('GET', path)) as Bundle;
      return fromBundle({ ...raw, oneTimePrekey: consume ? raw.oneTimePrekey : null }, userId);
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  }

  async function handle(req: ServerRequest, from: { userId: string }): Promise<string> {
    const b = JSON.parse(req.body) as Json;
    switch (req.kind) {
      case 'keys.upload': {
        // A reloaded OlmMachine re-generates OTKs on every page load; don't grow the server pool past
        // OTK_POOL_TARGET (it 409s at 500 and that broke init). Skipped OTKs are simply never claimable.
        const getCount = async () => ((await http.request('GET', '/keys/count')) as { oneTimePrekeyCount: number }).oneTimePrekeyCount;
        let count = await getCount();
        for (const body of toPublishBodies(req.body, from.userId)) {
          const b2: Json = { ...body };
          if (count >= OTK_POOL_TARGET) delete b2.oneTimePrekeys;
          if (!Object.keys(b2).length) continue;
          try {
            count = ((await http.request('POST', '/keys/publish', b2)) as { oneTimePrekeyCount: number }).oneTimePrekeyCount;
          } catch (e) {
            const err = e as { status?: number; code?: string; body?: { error?: string } };
            if (err.status !== 409) throw e;
            delete b2.oneTimePrekeys;
            if (Object.keys(b2).length) await http.request('POST', '/keys/publish', b2);
            count = await getCount();
          }
        }
        return JSON.stringify({ one_time_key_counts: { [ALGO]: count } });
      }
      case 'keys.query': {
        const out: Record<string, Json> = {};
        const us = Object.keys(b.device_keys as Json);
        const raw = await fetchIdentities(http, us.map(usernameOf));
        for (const u of us) {
          const r = raw.get(usernameOf(u)) as Bundle | null | undefined;
          const d = r ? fromBundle({ ...r, oneTimePrekey: null }, u) : null;
          out[u] = d ? { [d.deviceId]: d.deviceKeys } : {};
        }
        return JSON.stringify({ device_keys: out, failures: {} });
      }
      case 'keys.claim': {
        const out: Record<string, Json> = {};
        for (const [u, ds] of Object.entries(b.one_time_keys as Record<string, Json>)) {
          const d = await fetchKeys(u, true);
          if (!d || !(d.deviceId in ds)) continue;
          const k = d.oneTime ?? d.signedPrekey; // fall back to signed prekey when pool is empty
          out[u] = { [d.deviceId]: { [k.id]: k.key } };
        }
        return JSON.stringify({ one_time_keys: out, failures: {} });
      }
      default:
        // Messages travel via /conversations/:id/messages (encodeMessage), not here.
        return JSON.stringify({});
    }
  }
  return { send: (req, from) => handle(req, from) };
}

// ---- messages ----
export interface MessageDto { id: string; senderId: string; seq: string; clientMsgId: string; ciphertext: string; version: number }

/** Body for POST /conversations/:id/messages. */
export function encodeMessage(env: CiphertextEnvelope, clientMsgId: string = randomMsgId()): { clientMsgId: string; ciphertext: string; version: number } {
  return { clientMsgId, ciphertext: jsonToB64(env, LIMITS.ciphertextBytes), version: WIRE_VERSION };
}

/** Parse a message DTO back into an envelope for adapter.receive(). */
export function decodeMessage(m: Pick<MessageDto, 'ciphertext' | 'version'>): CiphertextEnvelope {
  if (m.version !== WIRE_VERSION) throw new CryptoError('INVALID_ENVELOPE', 'Unsupported message version');
  if (fromB64(m.ciphertext).length > LIMITS.ciphertextBytes) throw new CryptoError('INVALID_ENVELOPE', 'Envelope too large');
  const e = b64ToJson<CiphertextEnvelope>(m.ciphertext);
  if (!e || typeof e !== 'object' || !e.sender || !e.recipient || !e.content) throw new CryptoError('INVALID_ENVELOPE', 'Malformed envelope');
  return e;
}

export function randomMsgId(): string {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return toB64(b).replace(/\+/g, '-').replace(/\//g, '_');
}

/** Low-water mark: ask the library to top up OTKs when the server pool drops below this. */
export const PREKEY_LOW_WATER = 20;
