/* eslint-disable @typescript-eslint/no-explicit-any -- test fake mirrors untyped HTTP JSON */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { FakeBackend } from './fake-backend.js';
import {
  createBackendTransport, createIdentityGate, createOlmAdapter, decodeMessage, encodeMessage, userIdFor,
  type CryptoAdapter, type StoredPeer,
} from '../src/index.js';

// Offline delivery through PR #13-shaped /conversations/:id/messages (store-and-forward).
let n = 0;
const CONV = 'conv-alice-bob';

function gate() {
  const mem = new Map<string, StoredPeer>();
  return createIdentityGate({ get: async (u) => mem.get(u), set: async (u, v) => void mem.set(u, v) });
}

async function setup() {
  const be = new FakeBackend();
  const id = ++n;
  const open = async (u: string, dev: string) => {
    const a = await createOlmAdapter({
      userId: userIdFor(u), deviceId: dev, transport: createBackendTransport(be.http(u)), storeName: `${u}-oq-${id}`, identityGate: gate(),
    });
    await a.sync();
    return a;
  };
  const alice = await open('alice', 'ALICE1');
  let bob: CryptoAdapter = await open('bob', 'BOB1'); // publishes keys once, then goes offline
  const bobAddr = bob.identity();
  bob.close();
  const send = async (from: CryptoAdapter, user: string, to: { userId: string; deviceId: string }, text: string) =>
    be.http(user).request('POST', `/conversations/${CONV}/messages`, encodeMessage(await from.encrypt(to, text)));
  const fetch = async (user: string, after: string) => {
    const out: any[] = [];
    let cursor = after;
    for (;;) {
      const page: any = await be.http(user).request('GET', `/conversations/${CONV}/messages?${new URLSearchParams({ after: cursor, limit: '2' })}`);
      out.push(...page.messages);
      if (!page.hasMore) return { messages: out, cursor: page.nextCursor ?? cursor };
      cursor = page.nextCursor;
    }
  };
  const inbound = (msgs: any[], me: string) => msgs.filter((m) => m.senderId !== me);
  return { be, alice, bobAddr, send, fetch, inbound, reopenBob: async () => (bob = await open('bob', 'BOB1')) };
}

describe('offline queue (store-and-forward, PR #13 shapes)', () => {
  it('Bob offline: 6 messages queued before any reply decrypt in seq order after reload, then ack', async () => {
    const { be, alice, bobAddr, send, fetch, inbound, reopenBob } = await setup();
    const texts = Array.from({ length: 6 }, (_, i) => `queued #${i + 1}`);
    for (const t of texts) await send(alice, 'alice', bobAddr, t);
    expect(be.bundleFetches).toBe(1); // one session, one OTK, regardless of queue length

    const bob = await reopenBob(); // reload from the persisted encrypted store
    const { messages, cursor } = await fetch('bob', '0');
    expect(messages.map((m) => m.seq)).toEqual(['1', '2', '3', '4', '5', '6']);
    const results = await bob.receive(messages.map(decodeMessage));
    expect(results.map((r) => (r.ok ? r.plaintext : r.error.code))).toEqual(texts);
    expect(cursor).toBe('6');
    const ack: any = await be.http('bob').request('POST', '/messages/ack', { messageIds: messages.map((m) => m.id) });
    expect(ack.acked).toBe(6);

    // Bob replies; Alice decrypts on the established session.
    await send(bob, 'bob', alice.identity(), 'got them all');
    const [r] = await alice.receive(inbound((await fetch('alice', '0')).messages, 'alice').map(decodeMessage));
    expect(r).toMatchObject({ ok: true, plaintext: 'got them all' });
  });

  it('Bob online twice: cursor resume fetches only new messages, no double-decrypt failures', async () => {
    const { alice, bobAddr, send, fetch, reopenBob } = await setup();
    for (const t of ['a1', 'a2', 'a3']) await send(alice, 'alice', bobAddr, t);
    let bob = await reopenBob();
    const first = await fetch('bob', '0');
    expect((await bob.receive(first.messages.map(decodeMessage))).every((r) => r.ok)).toBe(true);
    bob.close(); // offline again

    for (const t of ['a4', 'a5', 'a6']) await send(alice, 'alice', bobAddr, t);
    bob = await reopenBob();
    const second = await fetch('bob', first.cursor);
    expect(second.messages.map((m) => m.seq)).toEqual(['4', '5', '6']);
    const rs = await bob.receive(second.messages.map(decodeMessage));
    expect(rs.map((r) => (r.ok ? r.plaintext : r.error.code))).toEqual(['a4', 'a5', 'a6']);

    // A stale cursor re-delivers old messages: they fail closed per message (replay), new ones still decrypt.
    const overlap = await fetch('bob', '2');
    const ro = await bob.receive(overlap.messages.map(decodeMessage));
    expect(ro.slice(0, 4).every((r) => !r.ok)).toBe(true);
    await send(alice, 'alice', bobAddr, 'a7');
    const [r7] = await bob.receive((await fetch('bob', second.cursor)).messages.map(decodeMessage));
    expect(r7).toMatchObject({ ok: true, plaintext: 'a7' });
  });

  it('messages arriving out of order still decrypt (skipped message keys)', async () => {
    const { alice, bobAddr, send, fetch, reopenBob } = await setup();
    const texts = ['o1', 'o2', 'o3', 'o4', 'o5'];
    for (const t of texts) await send(alice, 'alice', bobAddr, t);
    const bob = await reopenBob();
    const { messages } = await fetch('bob', '0');
    const order = [3, 0, 4, 2, 1];
    const rs = await bob.receive(order.map((i) => decodeMessage(messages[i])));
    expect(rs.map((r) => (r.ok ? r.plaintext : r.error.code))).toEqual(order.map((i) => texts[i]));

    // After a reply (ratchet step), later Alice messages delivered in reverse also decrypt.
    await send(bob, 'bob', alice.identity(), 'ack');
    const back = (await fetch('alice', '0')).messages.filter((m) => m.senderId === 'bob');
    expect((await alice.receive(back.map(decodeMessage)))[0]).toMatchObject({ ok: true });
    for (const t of ['p1', 'p2', 'p3']) await send(alice, 'alice', bobAddr, t);
    const late = (await fetch('bob', '6')).messages.reverse();
    const rl = await bob.receive(late.map(decodeMessage));
    expect(rl.map((r) => (r.ok ? r.plaintext : r.error.code))).toEqual(['p3', 'p2', 'p1']);
  });
});
