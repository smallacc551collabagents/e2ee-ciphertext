import 'fake-indexeddb/auto';
import { memGate } from './mem-gate.js';
import { describe, expect, it } from 'vitest';
import { FakeBackend } from './fake-backend.js';
import {
  createBackendTransport, createIdentityGate, createOlmAdapter, createPeerVerifier, decodeMessage, encodeMessage, userIdFor,
  type CiphertextEnvelope, type StoredPeer,
} from '../src/index.js';

let n = 0;
async function setup() {
  const be = new FakeBackend();
  const id = ++n;
  const mem = new Map<string, StoredPeer>();
  const store = { get: async (u: string) => mem.get(u), set: async (u: string, v: StoredPeer) => void mem.set(u, v) };
  const mk = async (u: string, dev: string, storeName = `${u}-ig-${id}`, gated = false) => {
    const a = await createOlmAdapter({
      userId: userIdFor(u), deviceId: dev, transport: createBackendTransport(be.http(u)), storeName,
      identityGate: gated ? createIdentityGate(store) : memGate(),
    });
    await a.sync();
    return a;
  };
  const alice = await mk('alice', 'ALICE1', `alice-ig-${id}`, true);
  const bob = await mk('bob', 'BOB1');
  const verifier = createPeerVerifier({ adapter: alice, http: be.http('alice'), store });
  return { be, alice, bob, mk, mem, verifier, bobId: userIdFor('bob') };
}
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
function tamper(env: CiphertextEnvelope): CiphertextEnvelope {
  const c = structuredClone(env.content) as { ciphertext: Record<string, { body: string }> };
  const k = Object.keys(c.ciphertext)[0]!;
  const b = c.ciphertext[k]!.body;
  c.ciphertext[k]!.body = (b[0] === 'A' ? 'B' : 'A') + b.slice(1);
  return { ...env, content: c };
}

describe('encrypt identity gate (E2EE-37, defense in depth)', () => {
  it('first contact records the identity; later encrypts to the same identity succeed', async () => {
    const { alice, bob, mem, bobId } = await setup();
    await alice.encrypt(bob.identity(), 'hi');
    expect(mem.get(bobId)!.identity.ed25519).toBe(bob.identity().ed25519);
    expect(await code(alice.encrypt(bob.identity(), 'again'))).toBe('ok');
  });

  it('refuses a device that does not match the first-seen identity, without claiming an OTK', async () => {
    const { be, alice, bob, mk } = await setup();
    await alice.encrypt(bob.identity(), 'hi');
    const bob2 = await mk('bob', 'BOB2', `bob-new-${n}`);
    const bundles = be.bundleFetches;
    expect(await code(alice.encrypt(bob2.identity(), 'x'))).toBe('IDENTITY_CHANGED');
    expect(be.bundleFetches).toBe(bundles);
  });

  it('a refresh that marks the peer changed blocks encrypt, even to the old device, until accepted', async () => {
    const { alice, bob, mk, verifier, bobId } = await setup();
    await alice.receive([decodeMessage(encodeMessage(await bob.encrypt(alice.identity(), 'hello')))]);
    await alice.encrypt(bob.identity(), 'reply');
    const bob2 = await mk('bob', 'BOB2', `bob-reset-${n}`);
    const [r] = await verifier.onReceiveResults(await alice.receive([tamper(await bob2.encrypt(alice.identity(), 'x'))]));
    expect(r!.status).toBe('changed');
    expect(await code(alice.encrypt(bob.identity(), 'blocked'))).toBe('IDENTITY_CHANGED');
    expect(await code(alice.encrypt(bob2.identity(), 'blocked'))).toBe('IDENTITY_CHANGED');
    await verifier.acceptNewIdentity(r!.current!);
    expect(await code(alice.encrypt(bob2.identity(), 'ok now'))).toBe('ok');
    // The old device is gone from the published list (NO_DEVICE) or mismatches (IDENTITY_CHANGED); either way it's refused.
    expect(['NO_DEVICE', 'IDENTITY_CHANGED']).toContain(await code(alice.encrypt(bob.identity(), 'old device')));
    expect((await verifier.refresh(bobId)).status).toBe('unchanged');
  });
});

describe('identity gate records first-seen-in-group changes', () => {
  it('TOFU on first sight, then a changed device sets pendingChange (banner) until accepted', async () => {
    const mem = new Map<string, StoredPeer>();
    const gate = createIdentityGate({ get: async (u: string) => mem.get(u), set: async (u: string, v: StoredPeer) => void mem.set(u, v) });
    const d1 = { userId: 'd', deviceId: 'D1', ed25519: 'e1', curve25519: 'c1' };
    const d2 = { userId: 'd', deviceId: 'D2', ed25519: 'e2', curve25519: 'c2' };
    await gate.assertTrusted(d1);
    expect(mem.get('d')?.identity).toEqual(d1);
    await expect(gate.assertTrusted(d2)).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
    expect(mem.get('d')?.pendingChange).toEqual(d2);
    await expect(gate.assertUserNotPending('d')).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
  });
});
