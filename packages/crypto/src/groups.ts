/**
 * Group messaging (E2EE-53, Phase 6). Decision: docs/crypto-group-decision.md; API: docs/group-api-proposal.md.
 *
 * Megolm group sessions from @matrix-org/matrix-sdk-crypto-wasm (the library we already ship). Room keys are
 * distributed over existing Olm 1:1 sessions as to-device envelopes, gated by the identity gate and revocation
 * check. All cryptography is done by the library; this module only orchestrates rotation, distribution,
 * membership-version handling and key requests.
 */
import { CryptoError, type CiphertextEnvelope, type CryptoAdapter, type DeviceAddress, type DeviceIdentity } from './contract.js';
import type { PeerIdentityStore } from './peer-trust.js';
import { fromB64, toB64, userIdFor, usernameOf, type BackendHttp } from './backend-bridge.js';
import type { HistoryStore } from './history-store.js';
import { trackOpen } from './session.js';

/** Groups are enabled (Phase 6 opened). Kept as an export for callers that checked it. */
export const GROUPS_ENABLED = true as const;
export const GROUP_MAX_MEMBERS = 50;
export const GROUP_ROTATION_MESSAGES = 100;
export const GROUP_ROTATION_MS = 7 * 24 * 60 * 60 * 1000;
export const MEGOLM_ALG = 'm.megolm.v1.aes-sha2' as const;

/**
 * Call before 1:1 encrypt. Throws INVALID_OPTIONS unless it is a direct conversation with exactly two distinct
 * members including the local user. Group conversations use createGroupCrypto instead.
 */
export function assertDirectConversation(memberUserIds: readonly string[], selfUserId: string): string {
  const unique = [...new Set(memberUserIds)];
  if (unique.length !== 2 || !unique.includes(selfUserId)) {
    throw new CryptoError('INVALID_OPTIONS', 'Not a direct conversation; use createGroupCrypto for groups');
  }
  return unique.find((u) => u !== selfUserId)!;
}

// ---------- adapter primitives (implemented by createOlmAdapter) ----------
export interface GroupShareResult {
  /** Olm-encrypted room-key envelopes, one per current trusted member device. Deliver via the to-device queue. */
  readonly envelopes: CiphertextEnvelope[];
  /** Members not given the key: unaccepted identity change, revoked or no published device. */
  readonly pending: string[];
  readonly trusted: string[];
}
export type GroupDecryptResult =
  | { ok: true; plaintext: string; senderCurve25519: string; sessionId: string }
  | { ok: false; code: 'MISSING_ROOM_KEY' | 'DECRYPT_FAILED' | 'IDENTITY_CHANGED' | 'INVALID_ENVELOPE'; sessionId: string };
export type ToDeviceResult =
  | { envelope: CiphertextEnvelope; kind: 'room_key'; groupId?: string; sessionId?: string }
  | { envelope: CiphertextEnvelope; kind: 'invalid' }
  | { envelope: CiphertextEnvelope; kind: 'message'; plaintext: string; senderCurve25519: string };
export interface GroupEventInput { eventId: string; sender: DeviceAddress; ts: number; content: Record<string, unknown> }

export interface GroupPrimitives {
  shareGroupKey(groupId: string, memberUserIds: readonly string[], o: { rotate: boolean; rotationMessages?: number; rotationUs?: bigint }): Promise<GroupShareResult>;
  encryptGroup(groupId: string, plaintext: string): Promise<Record<string, unknown>>;
  decryptGroup(groupId: string, ev: GroupEventInput): Promise<GroupDecryptResult>;
  exportGroupSession(groupId: string, sessionId: string): Promise<string | null>;
  importGroupSession(groupId: string, sessionId: string, senderCurve25519: string, json: string): Promise<boolean>;
  receiveToDevice(envelopes: readonly CiphertextEnvelope[]): Promise<ToDeviceResult[]>;
}

// ---------- wire ----------
export interface GroupEnvelope {
  readonly v: 1;
  readonly alg: typeof MEGOLM_ALG;
  readonly groupId: string;
  readonly sender: DeviceAddress;
  readonly membershipVersion: number;
  readonly content: Readonly<Record<string, unknown>>;
}
const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });
export function encodeGroupEnvelope(env: GroupEnvelope): string {
  const b = te.encode(JSON.stringify(env));
  if (b.length > 32 * 1024) throw new CryptoError('INVALID_ENVELOPE', 'Group message exceeds size cap');
  return toB64(b);
}
export function decodeGroupEnvelope(ciphertext: string): GroupEnvelope {
  try {
    const e = JSON.parse(td.decode(fromB64(ciphertext))) as GroupEnvelope;
    if (e.v !== 1 || e.alg !== MEGOLM_ALG || typeof e.groupId !== 'string' || !e.sender || typeof e.content !== 'object') throw new Error('shape');
    return e;
  } catch (err) {
    throw new CryptoError('INVALID_ENVELOPE', 'Malformed group envelope', { cause: err });
  }
}

// ---------- server contract (Backend) ----------
export interface GroupInfo { readonly id: string; readonly adminUserId: string; readonly membershipVersion: number; readonly members: readonly string[] }
export interface GroupMessageDto { id: string; seq: string; senderId: string; createdAt?: string; kind?: 'message' | 'member_event' | 'system'; clientMsgId?: string; ciphertext?: string; event?: { type: string; actor?: string; target?: string; membershipVersion: number } }
export interface ToDeviceDto { id: string; seq: string; sender: string; ciphertext: string }

/** What createGroupCrypto needs from the server. createHttpGroupBackend implements it over docs/group-api-proposal.md. */
export interface GroupBackend {
  getGroup(groupId: string): Promise<GroupInfo>;
  /** Rejects with {status: 409, body: {error: 'membership_changed'}} when membershipVersion is stale. */
  postMessage(groupId: string, body: { clientMsgId: string; ciphertext: string; version: 1; membershipVersion: number }): Promise<unknown>;
  sendToDevice(envelopes: readonly CiphertextEnvelope[]): Promise<void>;
}

/** to-device `type` used for Olm envelopes carrying group room keys / key requests. */
export const TO_DEVICE_TYPE_GROUP = 1;
/** 409 error codes meaning "membership changed: refetch, rotate, resend" (backend uses membership_changed). */
export const STALE_MEMBERSHIP_ERRORS: readonly string[] = ['membership_changed', 'stale_membership'];

/** Matches the merged backend (PR #56): GET /conversations (kind "group"), POST /to-device {recipient,ciphertext,type,version}. */
export function createHttpGroupBackend(http: BackendHttp): GroupBackend {
  return {
    async getGroup(id) {
      const r = (await http.request('GET', '/conversations')) as {
        conversations: { id: string; kind: string; adminId?: string | null; membershipVersion?: number; members: { id: string; username: string }[] }[];
      };
      const g = r.conversations.find((c) => c.id === id && c.kind === 'group');
      if (!g || typeof g.membershipVersion !== 'number') throw new CryptoError('INVALID_OPTIONS', 'Group not found');
      const admin = g.members.find((m) => m.id === g.adminId);
      return {
        id: g.id, adminUserId: admin ? userIdFor(admin.username) : '', membershipVersion: g.membershipVersion,
        members: g.members.map((m) => userIdFor(m.username)),
      };
    },
    postMessage: (id, body) => http.request('POST', `/conversations/${encodeURIComponent(id)}/messages`, body),
    async sendToDevice(envs) {
      for (let i = 0; i < envs.length; i += 100) {
        await http.request('POST', '/to-device', {
          messages: envs.slice(i, i + 100).map((e) => ({
            recipient: usernameOf(e.recipient.userId), ciphertext: toB64(te.encode(JSON.stringify(e))), type: TO_DEVICE_TYPE_GROUP, version: 1,
          })),
        });
      }
    },
  };
}
export function decodeToDevice(dto: Pick<ToDeviceDto, 'ciphertext'>): CiphertextEnvelope {
  try {
    return JSON.parse(td.decode(fromB64(dto.ciphertext))) as CiphertextEnvelope;
  } catch (err) {
    throw new CryptoError('INVALID_ENVELOPE', 'Malformed to-device envelope', { cause: err });
  }
}
function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------- local state (public metadata only: versions, session ids, member user ids) ----------
function exportedSenderKey(json: string): string | undefined {
  try { const a = JSON.parse(json) as { sender_key?: unknown }[]; return Array.isArray(a) && typeof a[0]?.sender_key === 'string' ? a[0].sender_key : undefined; } catch { return undefined; }
}

export interface GroupLocalState {
  /** membershipVersion the current outbound session was shared for; absent = must rotate. */
  sharedVersion?: number | undefined;
  /** Outbound session id -> members entitled to it (members at share time). Used to answer key requests. */
  sessionMembers: Record<string, string[]>;
  /** Inbound session ids whose key came from a member other than the session's creator (unverified, Matrix-style).
   * Cleared when the creator sends the same session directly. */
  forwarded?: Record<string, true>;
}
export interface GroupStateStore {
  get(groupId: string): Promise<GroupLocalState | undefined>;
  set(groupId: string, s: GroupLocalState): Promise<void>;
  delete(groupId: string): Promise<void>;
}
export function memoryGroupStateStore(): GroupStateStore {
  const m = new Map<string, GroupLocalState>();
  return { get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k) };
}

/** Persistent GroupStateStore (IndexedDB). Without it a reload forgets who was entitled to which session, so
 * every key request (e.g. from a member's new device) is refused. Holds public metadata only. */
export async function openGroupStateStore(dbName: string): Promise<GroupStateStore & { close(): void }> {
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open(dbName, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('g')) r.result.createObjectStore('g'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const untrackDb = trackOpen(dbName.replace(/-groups$/, ''), () => db.close());
  const tx = <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) => new Promise<T>((res, rej) => {
    const q = f(db.transaction('g', mode).objectStore('g'));
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  return {
    get: async (k) => (await tx<GroupLocalState | undefined>('readonly', (s) => s.get(k) as IDBRequest<GroupLocalState | undefined>)) ?? undefined,
    set: async (k, v) => void (await tx('readwrite', (s) => s.put(JSON.parse(JSON.stringify(v)) as GroupLocalState, k))),
    delete: async (k) => void (await tx('readwrite', (s) => s.delete(k))),
    close: () => { untrackDb(); db.close(); },
  };
}

export type KeySource = 'sender' | 'forwarded';
export type GroupReceiveResult =
  | { kind: 'message'; ok: true; dto: GroupMessageDto; sender: DeviceAddress; plaintext: string;
      /** 'forwarded': decrypted with a key relayed by another member, not by the sender; authenticity rests on that member. */
      keySource: KeySource }
  | { kind: 'message'; ok: false; dto: GroupMessageDto; code: 'MISSING_ROOM_KEY' | 'DECRYPT_FAILED' | 'IDENTITY_CHANGED' | 'INVALID_ENVELOPE' }
  | { kind: 'member_event'; dto: GroupMessageDto };

interface KeyRequest { t: 'org.e2ee.group.key_request'; groupId: string; sessionId: string }
interface KeyResponse { t: 'org.e2ee.group.key_response'; groupId: string; sessionId: string; keys: string }

export interface GroupCryptoOptions {
  adapter: CryptoAdapter & GroupPrimitives;
  backend: GroupBackend;
  /** If given, decrypted messages are written here before receive() returns (ack after). */
  history?: HistoryStore;
  state?: GroupStateStore;
  rotationMessages?: number;
  rotationMs?: number;
  maxRetries?: number;
  /** Map the server's senderId (user uuid on the real backend) to a username; default: senderId is the username. */
  senderUsername?: (senderId: string) => string | undefined;
  /** Same PeerIdentityStore the adapter's identity gate uses. Required for getPendingIdentities / acceptMemberIdentity. */
  peers?: PeerIdentityStore;
  /** Session key for closeCryptoSession(storeName); use the adapter's storeName (e2ee-<userId>). closeCryptoSession() closes all. */
  storeName?: string;
  /** Logged-in owner (library user id). Every operation refuses if the adapter belongs to someone else. */
  ownerUserId?: string;
}

export function createGroupCrypto(o: GroupCryptoOptions) {
  const a = o.adapter;
  const self = a.identity();
  const store = o.state ?? memoryGroupStateStore();
  if (o.ownerUserId !== undefined && self.userId !== o.ownerUserId) throw new CryptoError('INVALID_OPTIONS', 'Group crypto owner does not match the adapter identity');
  let closed = false;
  const requested = new Set<string>(); // `${groupId}|${sessionId}` requested by us
  const waiting = new Set<string>(); // groupIds with messages waiting for a key
  const deferred = new Map<string, { to: DeviceAddress; req: KeyRequest }[]>(); // key requests blocked by the identity gate
  const load = async (g: string): Promise<GroupLocalState> => (await store.get(g)) ?? { sessionMembers: {} };

  async function ensureShared(g: GroupInfo): Promise<{ pending: string[]; st: GroupLocalState; recipients: DeviceAddress[] }> {
    if (!g.members.includes(self.userId)) throw new CryptoError('INVALID_OPTIONS', 'Not a member of this group');
    if (g.members.length > GROUP_MAX_MEMBERS) throw new CryptoError('INVALID_OPTIONS', 'Group exceeds member cap');
    const st = await load(g.id);
    const rotate = st.sharedVersion !== g.membershipVersion;
    if (rotate) st.sharedVersion = undefined; // persisted only after delivery succeeds
    const share = await a.shareGroupKey(g.id, g.members, {
      rotate,
      rotationMessages: o.rotationMessages ?? GROUP_ROTATION_MESSAGES,
      rotationUs: BigInt(o.rotationMs ?? GROUP_ROTATION_MS) * 1000n,
    });
    try {
      await o.backend.sendToDevice(share.envelopes);
    } catch (e) {
      await store.set(g.id, { ...st, sharedVersion: undefined }); // undelivered keys: rotate next time
      throw new CryptoError('TRANSPORT_FAILED', 'Could not deliver group keys', { cause: e });
    }
    st.sharedVersion = g.membershipVersion;
    await store.set(g.id, st);
    return { pending: share.pending, st, recipients: share.envelopes.map((e) => e.recipient) };
  }

  async function send(groupId: string, plaintext: string, clientMsgId: string = randomId()) {
    const max = o.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      const g = await o.backend.getGroup(groupId);
      const { pending, st } = await ensureShared(g);
      const content = await a.encryptGroup(groupId, plaintext);
      const sid = String(content.session_id ?? '');
      st.sessionMembers[sid] = [...g.members];
      await store.set(groupId, st);
      const env: GroupEnvelope = { v: 1, alg: MEGOLM_ALG, groupId, sender: { userId: self.userId, deviceId: self.deviceId }, membershipVersion: g.membershipVersion, content };
      try {
        const message = await o.backend.postMessage(groupId, { clientMsgId, ciphertext: encodeGroupEnvelope(env), version: 1, membershipVersion: g.membershipVersion });
        return { message, pending, membershipVersion: g.membershipVersion, sessionId: sid };
      } catch (e) {
        const err = e as { status?: number; body?: { error?: string } };
        if (err.status === 409 && STALE_MEMBERSHIP_ERRORS.includes(String(err.body?.error)) && attempt < max) {
          await store.set(groupId, { ...st, sharedVersion: undefined }); // refetch + rotate
          continue;
        }
        throw e;
      }
    }
  }

  async function requestKey(groupId: string, sender: DeviceAddress, sessionId: string): Promise<void> {
    const k = `${groupId}|${sessionId}`;
    if (requested.has(k)) return;
    try {
      const req: KeyRequest = { t: 'org.e2ee.group.key_request', groupId, sessionId };
      await o.backend.sendToDevice([await a.encrypt(sender, JSON.stringify(req))]);
      requested.add(k);
    } catch {
      // Sender's identity pending / offline transport: stay "waiting for key"; retried on next receive.
    }
  }

  async function receive(groupId: string, dtos: readonly GroupMessageDto[]): Promise<GroupReceiveResult[]> {
    const out: GroupReceiveResult[] = [];
    const sorted = [...dtos].sort((x, y) => (BigInt(x.seq) < BigInt(y.seq) ? -1 : BigInt(x.seq) > BigInt(y.seq) ? 1 : 0));
    let missing = false;
    let cur: GroupInfo | null | undefined; // fetched lazily, once per receive()
    const fwd = (await store.get(groupId))?.forwarded ?? {};
    const entitled: Record<string, string[]> = {};
    for (const dto of sorted) {
      if (dto.kind === 'member_event' || dto.kind === 'system') {
        await onMembershipChanged(groupId);
        out.push({ kind: 'member_event', dto });
        continue;
      }
      let env: GroupEnvelope;
      try {
        env = decodeGroupEnvelope(dto.ciphertext ?? '');
        if (env.groupId !== groupId || env.sender.userId !== userIdFor(o.senderUsername ? (o.senderUsername(dto.senderId) ?? '\u0000') : dto.senderId)) throw new CryptoError('INVALID_ENVELOPE', 'Misaddressed');
      } catch {
        out.push({ kind: 'message', ok: false, dto, code: 'INVALID_ENVELOPE' });
        continue;
      }
      const ts = dto.createdAt ? Date.parse(dto.createdAt) : 0;
      const r = await a.decryptGroup(groupId, { eventId: dto.id, sender: env.sender, ts, content: env.content as Record<string, unknown> });
      if (r.ok) {
        await o.history?.put(groupId, dto.seq, {
          id: dto.id, senderUserId: env.sender.userId, senderDeviceId: env.sender.deviceId, text: r.plaintext,
          sentAt: dto.createdAt ?? new Date(ts).toISOString(), ...(dto.clientMsgId ? { clientMsgId: dto.clientMsgId } : {}),
        });
        out.push({ kind: 'message', ok: true, dto, sender: env.sender, plaintext: r.plaintext, keySource: fwd[r.sessionId] ? 'forwarded' : 'sender' });
        // Remember who was entitled to an inbound session we hold, so we can forward it to a member's accepted
        // new device (reshare / key requests) even when the original sender is offline or lost its device.
        // Only recorded when the message was sent for the current membership version (members = current list).
        if (r.sessionId && env.sender.userId !== self.userId && !entitled[r.sessionId]) {
          if (cur === undefined) { try { cur = await o.backend.getGroup(groupId); } catch { cur = null; } }
          if (cur && cur.membershipVersion === env.membershipVersion && cur.members.includes(env.sender.userId)) entitled[r.sessionId] = [...cur.members];
        }
      } else {
        if (r.code === 'MISSING_ROOM_KEY') {
          missing = true;
          await requestKey(groupId, env.sender, r.sessionId);
        }
        out.push({ kind: 'message', ok: false, dto, code: r.code });
      }
    }
    if (Object.keys(entitled).length) {
      const st = await load(groupId);
      let dirty = false;
      for (const [sid, mem] of Object.entries(entitled)) if (!st.sessionMembers[sid]) { st.sessionMembers[sid] = mem; dirty = true; }
      if (dirty) await store.set(groupId, st);
    }
    if (missing) waiting.add(groupId);
    else waiting.delete(groupId);
    return out;
  }

  async function answer(to: DeviceAddress, req: KeyRequest): Promise<'sent' | 'refused' | 'deferred'> {
    const st = await store.get(req.groupId);
    if (!st?.sessionMembers[req.sessionId]?.includes(to.userId)) return 'refused'; // not entitled (pre-join / never member)
    let g: GroupInfo;
    try { g = await o.backend.getGroup(req.groupId); } catch { return 'refused'; }
    if (!g.members.includes(to.userId)) return 'refused'; // removed / left
    const keys = await a.exportGroupSession(req.groupId, req.sessionId);
    if (!keys) return 'refused';
    try {
      const resp: KeyResponse = { t: 'org.e2ee.group.key_response', groupId: req.groupId, sessionId: req.sessionId, keys };
      await o.backend.sendToDevice([await a.encrypt(to, JSON.stringify(resp))]);
      return 'sent';
    } catch (e) {
      if (e instanceof CryptoError && e.code === 'IDENTITY_CHANGED') {
        const l = deferred.get(req.groupId) ?? [];
        l.push({ to, req });
        deferred.set(req.groupId, l);
        return 'deferred';
      }
      throw e;
    }
  }

  async function isMember(groupId: string, userId: string) {
    try { return ((g) => g.members.includes(userId) && g.members.includes(self.userId))(await o.backend.getGroup(groupId)); } catch { return false; }
  }

  async function receiveToDevice(envelopes: readonly CiphertextEnvelope[]) {
    const res = await a.receiveToDevice(envelopes);
    let roomKeys = 0;
    const answered: { to: DeviceAddress; groupId: string; status: 'sent' | 'refused' | 'deferred' }[] = [];
    const imported = new Set<string>();
    for (const r of res) {
      if (r.kind === 'room_key') { roomKeys++; continue; }
      if (r.kind !== 'message') continue;
      let m: KeyRequest | KeyResponse;
      try { m = JSON.parse(r.plaintext) as KeyRequest | KeyResponse; } catch { continue; }
      if (m.t === 'org.e2ee.group.key_request' && typeof m.groupId === 'string' && typeof m.sessionId === 'string') {
        answered.push({ to: r.envelope.sender, groupId: m.groupId, status: await answer(r.envelope.sender, m) });
      } else if (m.t === 'org.e2ee.group.key_response' && typeof m.keys === 'string' && typeof m.groupId === 'string' && typeof m.sessionId === 'string'
        && (requested.has(`${m.groupId}|${m.sessionId}`) || (waiting.has(m.groupId) && await isMember(m.groupId, r.envelope.sender.userId)))) {
        // Unsolicited responses are accepted only while we're waiting on that group and only from a current member
        // (pushed by reshare() after the sender accepted our new device; our own request may have been lost).
        const forwarded = exportedSenderKey(m.keys) !== r.senderCurve25519;
        if (forwarded && await a.exportGroupSession(m.groupId, m.sessionId)) continue; // never replace a held key with a forward
        if (await a.importGroupSession(m.groupId, m.sessionId, r.senderCurve25519, m.keys)) {
          requested.delete(`${m.groupId}|${m.sessionId}`);
          imported.add(m.groupId);
          await setForwarded(m.groupId, m.sessionId, forwarded);
        }
      }
    }
    for (const r of res) if (r.kind === 'room_key' && r.groupId && r.sessionId) await setForwarded(r.groupId, r.sessionId, false);
    const retry = roomKeys ? [...new Set([...waiting, ...imported])] : [...imported];
    return { roomKeys, answered, retry };
  }

  /** Direct key from the creator clears the flag. Megolm session ids are the creator's signing key, so every message
   * that decrypts in that session is then authenticated even if the store kept the forwarded copy (lower index). */
  async function setForwarded(groupId: string, sessionId: string, forwarded: boolean) {
    const st = await store.get(groupId);
    if (!forwarded && !st?.forwarded?.[sessionId]) return;
    const next = st ?? { sessionMembers: {} };
    const f = { ...(next.forwarded ?? {}) };
    if (forwarded) f[sessionId] = true; else delete f[sessionId];
    await store.set(groupId, { ...next, forwarded: f });
  }

  async function onMembershipChanged(groupId: string): Promise<void> {
    const st = await load(groupId);
    await store.set(groupId, { ...st, sharedVersion: undefined });
  }

  /** After the user accepts a changed safety number: rotate+share on next send and answer deferred key requests. */
  async function reshare(groupId: string, acceptedUserIds: readonly string[] = []) {
    await onMembershipChanged(groupId);
    const g = await o.backend.getGroup(groupId);
    const r = await ensureShared(g);
    const l = deferred.get(groupId) ?? [];
    deferred.delete(groupId);
    const statuses = [];
    const done = new Set<string>();
    for (const d of l) { done.add(`${d.to.userId}|${d.to.deviceId}|${d.req.sessionId}`); statuses.push(await answer(d.to, d.req)); }
    // Deferred requests live in memory and are lost on reload, so also push every older session the newly
    // accepted member was entitled to (answer() re-checks entitlement + current membership) to their current device.
    const accepted = new Set(acceptedUserIds);
    for (const to of r.recipients) {
      if (!accepted.has(to.userId)) continue;
      for (const [sessionId, mem] of Object.entries(r.st.sessionMembers)) {
        if (!mem.includes(to.userId) || done.has(`${to.userId}|${to.deviceId}|${sessionId}`)) continue;
        statuses.push(await answer(to, { t: 'org.e2ee.group.key_request', groupId, sessionId }));
      }
    }
    // Re-request keys we are still waiting for (e.g. our own device was replaced and earlier requests were dropped).
    for (const k of [...requested]) if (k.startsWith(`${groupId}|`)) requested.delete(k);
    return { pending: r.pending, answered: statuses };
  }

  /** Left / removed / group deleted: drop local outbound state. */
  async function forget(groupId: string) {
    await store.delete(groupId);
    waiting.delete(groupId);
    deferred.delete(groupId);
  }

  function needPeers(): PeerIdentityStore {
    if (!o.peers) throw new CryptoError('INVALID_OPTIONS', 'createGroupCrypto({ peers }) is required for identity hooks');
    return o.peers;
  }
  /** Members of the group whose known identity changed and is not accepted yet (keys are withheld from them). */
  async function getPendingIdentities(groupId: string): Promise<{ userId: string; previous: DeviceIdentity; current: DeviceIdentity }[]> {
    const peers = needPeers();
    const g = await o.backend.getGroup(groupId);
    const out = [];
    for (const u of g.members) {
      if (u === self.userId) continue;
      const s = await peers.get(u);
      if (s?.pendingChange) out.push({ userId: u, previous: s.identity, current: s.pendingChange });
    }
    return out;
  }
  /** Call on membership refresh / poll: re-queries member devices (TOFU for first-seen members, records changes as
   * pending), shares the current key to trusted members, and returns the pending ones. Never shares to a changed identity. */
  async function refreshMembers(groupId: string) {
    const g = await o.backend.getGroup(groupId);
    const r = await ensureShared(g);
    return { pending: r.pending, identities: o.peers ? await getPendingIdentities(groupId) : [] };
  }
  /** Explicit user accept of a member's new safety number, then push every older key they are entitled to. */
  async function acceptMemberIdentity(groupId: string, userId: string) {
    const peers = needPeers();
    const s = await peers.get(userId);
    if (!s?.pendingChange) return reshare(groupId, []);
    await peers.set(userId, { identity: s.pendingChange, checkedAt: Date.now() });
    return reshare(groupId, [userId]);
  }

  // Logout: closeCryptoSession() drops in-memory key-request state and makes this instance unusable,
  // so a later login can never send or answer with the previous user's group state.
  const untrack = trackOpen(o.storeName ?? `groups:${self.userId}`, () => {
    closed = true; requested.clear(); waiting.clear(); deferred.clear();
  });
  const guard = () => {
    if (closed) throw new CryptoError('NOT_INITIALIZED', 'Group crypto is closed (logged out)');
    const now = a.identity().userId;
    if (now !== self.userId || (o.ownerUserId !== undefined && now !== o.ownerUserId)) throw new CryptoError('INVALID_OPTIONS', 'Group crypto owner mismatch');
  };
  const g = <A extends unknown[], R>(f: (...x: A) => Promise<R>) => async (...x: A): Promise<R> => { guard(); return f(...x); };
  return {
    send: g(send),
    receive: g(receive),
    receiveToDevice: g(receiveToDevice),
    onMembershipChanged: g(onMembershipChanged),
    reshare: g(reshare),
    forget: g(forget),
    getPendingIdentities: g(getPendingIdentities),
    refreshMembers: g(refreshMembers),
    acceptMemberIdentity: g(acceptMemberIdentity),
    isWaiting: (id: string) => !closed && waiting.has(id),
    close: () => { if (!closed) { closed = true; requested.clear(); waiting.clear(); deferred.clear(); } untrack(); },
  };
}
export type GroupCrypto = ReturnType<typeof createGroupCrypto>;
