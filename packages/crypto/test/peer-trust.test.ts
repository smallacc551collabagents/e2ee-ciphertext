import 'fake-indexeddb/auto';
import { memGate } from './mem-gate.js';
import { describe, expect, it } from 'vitest';
import { FakeBackend } from './fake-backend.js';
import {
  DAY_MS, createBackendTransport, createOlmAdapter, createPeerVerifier, decodeMessage, encodeMessage, userIdFor,
  type CiphertextEnvelope, type StoredPeer,
} from '../src/index.js';

let n = 0;
async function setup() {
  const be = new FakeBackend();
  const id = ++n;
  const mk = async (u: string, dev: string, store = `${u}-pt-${id}`) => {
    const a = await createOlmAdapter({ userId: userIdFor(u), deviceId: dev, transport: createBackendTransport(be.http(u)), storeName: store, identityGate: memGate() });
    await a.sync();
    return a;
  };
  const alice = await mk('alice', 'ALICE1');
  const bob = await mk('bob', 'BOB1');
  const mem = new Map<string, StoredPeer>();
  let clock = 1_000_000;
  const verifier = createPeerVerifier({
    adapter: alice, http: be.http('alice'), now: () => clock,
    store: { get: async (u) => mem.get(u), set: async (u, v) => void mem.set(u, v) },
  });
  return { be, alice, bob, mk, mem, verifier, tick: (ms: number) => (clock += ms), bobId: userIdFor('bob') };
}

function tamper(env: CiphertextEnvelope): CiphertextEnvelope {
  const c = structuredClone(env.content) as { ciphertext: Record<string, { body: string }> };
  const k = Object.keys(c.ciphertext)[0]!;
  const body = c.ciphertext[k]!.body;
  c.ciphertext[k]!.body = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
  return { ...env, content: c };
}

describe('peer identity refresh (E2EE-37)', () => {
  it('first use stores the verified identity; unchanged keys stay unchanged', async () => {
    const { verifier, bob, bobId, mem } = await setup();
    expect((await verifier.refresh(bobId)).status).toBe('first-use');
    expect(mem.get(bobId)!.identity.ed25519).toBe(bob.identity().ed25519);
    expect((await verifier.refresh(bobId)).status).toBe('unchanged');
  });

  it('(a) a decrypt failure triggers a refresh that surfaces IDENTITY_CHANGED after a peer key reset', async () => {
    const { be, alice, bob, mk, verifier, bobId, mem } = await setup();
    await alice.receive([decodeMessage(encodeMessage(await bob.encrypt(alice.identity(), 'hi')))]);
    await verifier.refresh(bobId);
    const before = be.identityFetches;
    // Bob reinstalls: new identity published under his username.
    const bob2 = await mk('bob', 'BOB2', `bob-reset-${n}`);
    const bad = tamper(await bob2.encrypt(alice.identity(), 'x'));
    const results = await alice.receive([bad]);
    expect(results[0]!.ok).toBe(false);
    const [r] = await verifier.onReceiveResults(results);
    expect(be.identityFetches).toBeGreaterThan(before);
    expect(r).toMatchObject({ status: 'changed', error: { code: 'IDENTITY_CHANGED' } });
    expect(mem.get(bobId)!.identity.ed25519).toBe(bob.identity().ed25519); // not silently replaced
    expect((await verifier.refresh(bobId)).status).toBe('changed'); // stays changed until re-verified
    await verifier.acceptNewIdentity(r!.current!);
    expect((await verifier.refresh(bobId)).status).toBe('unchanged');
  });

  it('(a) successful messages trigger no refresh', async () => {
    const { be, alice, bob, verifier } = await setup();
    const results = await alice.receive([decodeMessage(encodeMessage(await bob.encrypt(alice.identity(), 'ok')))]);
    const before = be.identityFetches;
    expect(await verifier.onReceiveResults(results)).toEqual([]);
    expect(be.identityFetches).toBe(before);
  });

  it('(b) refreshStale only re-checks after maxAge and flags a key change under the same device id', async () => {
    const { be, mk, verifier, tick, bobId, bob, mem } = await setup();
    await verifier.refresh(bobId);
    const calls = be.identityFetches;
    expect(await verifier.refreshStale([bobId])).toEqual([]);
    expect(be.identityFetches).toBe(calls);
    tick(DAY_MS - 1);
    expect(await verifier.refreshStale([bobId])).toEqual([]);
    tick(1);
    expect((await verifier.refreshStale([bobId]))[0]!.status).toBe('unchanged');
    // Same device id, new keys (e.g. reinstall reusing BOB1): library refuses it; we flag it.
    await mk('bob', 'BOB1', `bob-same-dev-${n}`);
    tick(DAY_MS);
    const [r] = await verifier.refreshStale([bobId]);
    expect(r).toMatchObject({ status: 'changed', error: { code: 'IDENTITY_CHANGED' } });
    expect(mem.get(bobId)!.identity.ed25519).toBe(bob.identity().ed25519);
  });
});
