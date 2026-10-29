/**
 * Group messaging (E2EE-53, Phase 6). Decision: docs/crypto-group-decision.md; API: docs/group-api-proposal.md.
 *
 * Megolm group sessions from @matrix-org/matrix-sdk-crypto-wasm (the library we already ship). Room keys are
 * distributed over existing Olm 1:1 sessions as to-device envelopes, gated by the identity gate and revocation
 * check. All cryptography is done by the library; this module only orchestrates rotation, distribution,
 * membership-version handling and key requests.
 */
import { CryptoError, type CiphertextEnvelope, type CryptoAdapter, type DeviceAddress } from './contract.js';
import { fromB64, toB64, userIdFor, usernameOf, type BackendHttp } from './backend-bridge.js';
import type { HistoryStore } from './history-store.js';

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
  | { envelope: CiphertextEnvelope; kind: 'room_key' | 'invalid' }
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
export interface GroupLocalState {
  /** membershipVersion the current outbound session was shared for; absent = must rotate. */
  sharedVersion?: number | undefined;
  /** Outbound session id -> members entitled to it (members at share time). Used to answer key requests. */
  sessionMembers: Record<string, string[]>;
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
  const tx = <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) => new Promise<T>((res, rej) => {
    const q = f(db.transaction('g', mode).objectStore('g'));
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  return {
    get: async (k) => (await tx<GroupLocalState | undefined>('readonly', (s) => s.get(k) as IDBRequest<GroupLocalState | undefined>)) ?? undefined,
    set: async (k, v) => void (await tx('readwrite', (s) => s.put(JSON.parse(JSON.stringify(v)) as GroupLocalState, k))),
    delete: async (k) => void (await tx('readwrite', (s) => s.delete(k))),
    close: () => db.close(),
  };
}

export type GroupReceiveResult =
  | { kind: 'message'; ok: true; dto: GroupMessageDto; sender: DeviceAddress; plaintext: string }
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
}

export function createGroupCrypto(o: GroupCryptoOptions) {
  const a = o.adapter;
  const self = a.identity();
  const store = o.state ?? memoryGroupStateStore();
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
        out.push({ kind: 'message', ok: true, dto, sender: env.sender, plaintext: r.plaintext });
      } else {
        if (r.code === 'MISSING_ROOM_KEY') {
          missing = true;
          await requestKey(groupId, env.sender, r.sessionId);
        }
        out.push({ kind: 'message', ok: false, dto, code: r.code });
      }
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
        if (await a.importGroupSession(m.groupId, m.sessionId, r.senderCurve25519, m.keys)) {
          requested.delete(`${m.groupId}|${m.sessionId}`);
          imported.add(m.groupId);
        }
      }
    }
    const retry = roomKeys ? [...new Set([...waiting, ...imported])] : [...imported];
    return { roomKeys, answered, retry };
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

  return { send, receive, receiveToDevice, onMembershipChanged, reshare, forget, isWaiting: (g: string) => waiting.has(g) };
}
export type GroupCrypto = ReturnType<typeof createGroupCrypto>;
