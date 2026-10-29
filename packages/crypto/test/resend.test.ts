/* eslint-disable @typescript-eslint/no-explicit-any -- test fake mirrors untyped HTTP JSON */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { FakeBackend } from './fake-backend.js';
import { UNDELIVERABLE_DEVICE_CHANGED as SHARED_REASON, undeliverableListSchema } from '@e2ee/shared';
import {
  createBackendTransport, createIdentityGate, createOlmAdapter, createPeerVerifier, createResender, decodeMessage, encodeMessage,
  fetchUndeliverable, isForPreviousDevice, UNDELIVERABLE_DEVICE_CHANGED, openHistoryStore, userIdFor, type StoredPeer,
} from '../src/index.js';

const CONV = 'conv-resend';
let n = 0;

async function scenario() {
  const be = new FakeBackend();
  const id = ++n;
  const peers = new Map<string, StoredPeer>();
  const store = { get: async (u: string) => peers.get(u), set: async (u: string, v: StoredPeer) => void peers.set(u, v) };
  const open = async (u: string, dev: string, s: typeof store) => {
    const a = await createOlmAdapter({ userId: userIdFor(u), deviceId: dev, transport: createBackendTransport(be.http(u)), storeName: `${u}-${dev}-rs-${id}`, identityGate: createIdentityGate(s) });
    await a.sync();
    return a;
  };
  const bobPeers = new Map<string, StoredPeer>();
  const bobStore = { get: async (u: string) => bobPeers.get(u), set: async (u: string, v: StoredPeer) => void bobPeers.set(u, v) };
  const alice = await open('alice', 'ALICE1', store);
  const bob1 = await open('bob', 'BOB1', bobStore);
  const bobId = userIdFor('bob');
  const verifier = createPeerVerifier({ adapter: alice, http: be.http('alice'), store });
  await verifier.refresh(bobId); // first use: BOB1 trusted
  const history = await openHistoryStore(`alice-hist-rs-${id}`);
  // Live-adapter-shaped send: identity-gated encrypt to the peer's current device, POST, persist plaintext locally.
  const send = async (conversationId: string, text: string, clientMsgId: string) => {
    const devs = await alice.refreshPeer(bobId);
    const env = await alice.encrypt({ userId: bobId, deviceId: devs[0]!.deviceId }, text);
    const { message }: any = await be.http('alice').request('POST', `/conversations/${conversationId}/messages`, encodeMessage(env, clientMsgId));
    await history.put(conversationId, message.seq, { id: message.id, senderUserId: alice.identity().userId, senderDeviceId: 'ALICE1', text, sentAt: message.createdAt, clientMsgId });
    return env;
  };
  const fetchBob = async () => ((await be.http('bob').request('GET', `/conversations/${CONV}/messages?after=0`)) as any).messages.filter((m: any) => m.senderId !== 'bob');
  const resender = createResender({ parse: (r) => undeliverableListSchema.parse(r), http: be.http('alice'), history, selfUserId: alice.identity().userId, send });
  return { be, alice, bob1, bobId, verifier, send, fetchBob, resender, open, bobStore };
}

describe('resend after recipient device change', () => {
  it('A sends 3 while B offline, B replaces device, A accepts -> B gets all 3 decrypted, in order, once', async () => {
    const s = await scenario();
    s.bob1.close(); // offline
    const texts = ['m1 offline', 'm2 offline', 'm3 offline'];
    const oldEnvs = [];
    for (const [i, t] of texts.entries()) oldEnvs.push(await s.send(CONV, t, `cmid-000${i + 1}`));

    // B clears storage and confirms "Use this browser": new device, new identity published.
    const bob2 = await s.open('bob', 'BOB2', s.bobStore);
    expect(await s.fetchBob()).toEqual([]); // the new device never receives old-device ciphertext

    // Sender sees the flagged messages with their plaintext from local history.
    const pending = await s.resender.pendingResends(CONV);
    expect(pending.map((p) => [p.clientMsgId, p.text])).toEqual([['cmid-0001', 'm1 offline'], ['cmid-0002', 'm2 offline'], ['cmid-0003', 'm3 offline']]);

    // No auto-resend before acceptNewIdentity: the identity gate refuses.
    const r = await s.verifier.refresh(s.bobId);
    expect(r.status).toBe('changed');
    const blocked = await s.resender.resendPending(CONV);
    expect(blocked.resent).toEqual([]);
    expect(blocked.failed).toHaveLength(3);
    expect(await s.fetchBob()).toEqual([]);

    await s.verifier.acceptNewIdentity(r.current!);
    const done = await s.resender.resendPending(CONV);
    expect(done).toEqual({ resent: ['cmid-0001', 'cmid-0002', 'cmid-0003'], missing: [], failed: [] });
    expect(await s.resender.pendingResends(CONV)).toEqual([]);
    expect((await s.resender.resendPending(CONV)).resent).toEqual([]); // idempotent

    const msgs = await s.fetchBob();
    expect(msgs.map((m: any) => m.seq)).toEqual(['1', '2', '3']);
    expect(msgs.map((m: any) => m.clientMsgId)).toEqual(['cmid-0001', 'cmid-0002', 'cmid-0003']);
    const rs = await bob2.receive(msgs.map(decodeMessage));
    expect(rs.map((x) => (x.ok ? x.plaintext : x.error.code))).toEqual(texts);
    expect(s.be.messages).toHaveLength(3); // replaced in place, no duplicates

    // Receiver fallback: old ciphertext that still arrives is recognised as previous-device.
    const [old] = await bob2.receive([oldEnvs[0]!]);
    expect(old!.ok).toBe(false);
    expect(isForPreviousDevice(old!.ok ? undefined : old!.envelope, bob2.identity())).toBe(true);
    const [fresh] = await bob2.receive([await s.alice.encrypt({ userId: s.bobId, deviceId: 'BOB2' }, 'x')]);
    expect(fresh!.ok).toBe(true);
    expect(isForPreviousDevice(await s.alice.encrypt({ userId: s.bobId, deviceId: 'BOB2' }, 'y'), bob2.identity())).toBe(false);
  });

  it('reason constant matches @e2ee/shared', () => expect(UNDELIVERABLE_DEVICE_CHANGED).toBe(SHARED_REASON));

  it('missing endpoint (404) means nothing pending', async () => {
    const be = new FakeBackend();
    be.noUndeliverableRoute = true;
    expect(await fetchUndeliverable(be.http('alice'), CONV)).toEqual([]);
  });
});
