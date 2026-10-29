/* eslint-disable @typescript-eslint/no-explicit-any -- test fake mirrors untyped HTTP JSON */
import { FakeBackend } from './fake-backend.js';
import {
  createBackendTransport, createGroupCrypto, createIdentityGate, createOlmAdapter, createPeerVerifier, decodeToDevice,
  userIdFor, usernameOf, withRevocationCheck, type CiphertextEnvelope, type GroupBackend, type GroupMessageDto, type StoredPeer,
} from '../src/index.js';

const err = (status: number, error: string) => Object.assign(new Error(error), { status, body: { error } });

/** Fake of the group server contract in docs/group-api-proposal.md (Backend owns the real one). */
export class FakeGroupServer {
  keys = new FakeBackend();
  direct = new Set<string>(); // "a|b" sorted
  groups = new Map<string, { admin: string; version: number; members: { u: string; joinedSeq: bigint; at: number }[]; msgs: any[] }>();
  toDevice: { id: string; seq: number; recipient: string; deviceId: string; sender: string; ciphertext: string }[] = [];
  currentDevice = new Map<string, string>();
  posts = 0;
  private clock = 0;
  private n = 0;

  dm(a: string, b: string) { this.direct.add([a, b].sort().join('|')); }
  private hasDm(a: string, b: string) { return this.direct.has([a, b].sort().join('|')); }
  private g(id: string, caller: string) {
    const g = this.groups.get(id);
    if (!g || !g.members.some((m) => m.u === caller)) throw err(404, 'not_found');
    return g;
  }
  private event(id: string, type: string, actor: string, target: string) {
    const g = this.groups.get(id)!;
    g.version++;
    g.msgs.push({ id: `e${++this.n}`, seq: String(g.msgs.length + 1), senderId: actor, kind: 'member_event', event: { type, actor, target, membershipVersion: g.version }, createdAt: new Date().toISOString() });
  }
  create(id: string, admin: string, members: string[]) {
    if (members.length + 1 > 50) throw err(409, 'group_full');
    for (const m of members) if (!this.hasDm(admin, m)) throw err(403, 'no_direct_chat');
    this.groups.set(id, { admin, version: 0, members: [{ u: admin, joinedSeq: 0n, at: this.clock++ }], msgs: [] });
    this.event(id, 'created', admin, admin);
    for (const m of members) this.groups.get(id)!.members.push({ u: m, joinedSeq: BigInt(this.groups.get(id)!.msgs.length), at: this.clock++ });
    if (members.length) this.event(id, 'added', admin, members.join(','));
  }
  add(id: string, caller: string, u: string) {
    const g = this.g(id, caller);
    if (!this.hasDm(caller, u)) throw err(403, 'no_direct_chat');
    if (g.members.length >= 50) throw err(409, 'group_full');
    if (g.members.some((m) => m.u === u)) return;
    g.members.push({ u, joinedSeq: BigInt(g.msgs.length + 1), at: this.clock++ });
    this.event(id, 'added', caller, u);
  }
  remove(id: string, caller: string, u: string) {
    const g = this.g(id, caller);
    if (u === g.admin) throw err(403, 'cannot_remove_admin');
    g.members = g.members.filter((m) => m.u !== u);
    this.event(id, 'removed', caller, u);
  }
  leave(id: string, caller: string) {
    const g = this.g(id, caller);
    g.members = g.members.filter((m) => m.u !== caller);
    if (!g.members.length) { this.groups.delete(id); return { deleted: true }; }
    this.event(id, 'left', caller, caller);
    if (g.admin === caller) { g.admin = [...g.members].sort((a, b) => a.at - b.at)[0]!.u; this.event(id, 'admin_changed', caller, g.admin); }
    return { deleted: false };
  }
  fetch(id: string, user: string, after = '0'): GroupMessageDto[] {
    const g = this.g(id, user);
    const me = g.members.find((m) => m.u === user)!;
    return g.msgs.filter((m) => BigInt(m.seq) > BigInt(after) && BigInt(m.seq) > me.joinedSeq && (m.kind === 'member_event' || m.senderId !== user));
  }
  drainToDevice(user: string): CiphertextEnvelope[] {
    const dev = this.currentDevice.get(user);
    const mine = this.toDevice.filter((t) => t.recipient === user && t.deviceId === dev);
    this.toDevice = this.toDevice.filter((t) => !mine.includes(t));
    return mine.map((t) => decodeToDevice(t));
  }
  backend(user: string): GroupBackend {
    return {
      getGroup: async (id) => {
        const g = this.g(id, user);
        return { id, adminUserId: userIdFor(g.admin), membershipVersion: g.version, members: g.members.map((m) => userIdFor(m.u)) };
      },
      postMessage: async (id, body) => {
        const g = this.g(id, user);
        if (body.membershipVersion !== g.version) throw err(409, 'membership_changed');
        this.posts++;
        const m = { id: `m${++this.n}`, seq: String(g.msgs.length + 1), senderId: user, kind: 'message', createdAt: new Date().toISOString(), ...body };
        g.msgs.push(m);
        return m;
      },
      sendToDevice: async (envs) => {
        for (const e of envs) {
          const r = usernameOf(e.recipient.userId);
          if (this.currentDevice.get(r) !== e.recipient.deviceId) throw err(409, 'device_changed');
          this.toDevice.push({ id: `t${++this.n}`, seq: this.n, recipient: r, deviceId: e.recipient.deviceId, sender: user, ciphertext: Buffer.from(JSON.stringify(e)).toString('base64') });
        }
      },
    };
  }
}

let run = 0;
export async function member(s: FakeGroupServer, u: string, dev = `${u.toUpperCase()}1`, opts: { rotationMessages?: number; storeName?: string; state?: import("../src/index.js").GroupStateStore } = {}) {
  const storeName = opts.storeName ?? `${u}-${dev}-grp-${++run}`;
  const peers = new Map<string, StoredPeer>();
  const store = { get: async (k: string) => peers.get(k), set: async (k: string, v: StoredPeer) => void peers.set(k, v) };
  const http = s.keys.http(u);
  const adapter = await createOlmAdapter({
    userId: userIdFor(u), deviceId: dev, transport: createBackendTransport(http), storeName,
    identityGate: withRevocationCheck(createIdentityGate(store), { http, store, maxAgeMs: 0 }),
  });
  await adapter.sync();
  // Device replaced: undelivered to-device messages for the old device are dropped (contract).
  const prev = s.currentDevice.get(u);
  if (prev && prev !== dev) s.toDevice = s.toDevice.filter((t) => !(t.recipient === u && t.deviceId === prev));
  s.currentDevice.set(u, dev);
  const groups = createGroupCrypto({ adapter, backend: s.backend(u), ...(opts.state ? { state: opts.state } : {}), ...(opts.rotationMessages ? { rotationMessages: opts.rotationMessages } : {}) });
  const verifier = createPeerVerifier({ adapter, http, store });
  const cursor = new Map<string, string>();
  return {
    u, storeName, adapter, groups, verifier, peers,
    send: (g: string, text: string) => groups.send(g, text),
    /** Pull to-device then group messages (from the last cursor), return plaintexts/codes in seq order. */
    async sync(g: string) {
      await groups.receiveToDevice(s.drainToDevice(u));
      const dtos = s.fetch(g, u, cursor.get(g) ?? '0');
      const res = await groups.receive(g, dtos);
      const done = res.filter((r) => r.kind === 'member_event' || r.ok);
      const firstFail = res.find((r) => r.kind === 'message' && !r.ok);
      // Advance (ack) only up to the first message still waiting for a key.
      const ackable = firstFail ? res.slice(0, res.indexOf(firstFail)) : res;
      if (ackable.length) cursor.set(g, ackable[ackable.length - 1]!.dto.seq);
      return { res, texts: done.filter((r) => r.kind === 'message').map((r: any) => r.plaintext as string) };
    },
    close: () => adapter.close(),
  };
}
