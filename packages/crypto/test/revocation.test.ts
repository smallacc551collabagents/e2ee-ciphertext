import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { FakeBackend } from './fake-backend.js';
import { memGate } from './mem-gate.js';
import {
  createBackendTransport, createIdentityGate, createOlmAdapter, userIdFor, withRevocationCheck, type StoredPeer,
} from '../src/index.js';

let n = 0;
async function setup(opts: { failHttp?: () => boolean } = {}) {
  const be = new FakeBackend();
  const id = ++n;
  const mem = new Map<string, StoredPeer>();
  const store = { get: async (u: string) => mem.get(u), set: async (u: string, v: StoredPeer) => void mem.set(u, v) };
  let t = 1_000_000;
  const http = be.http('alice');
  const guarded = { request: (m: string, p: string, b?: unknown) => (opts.failHttp?.() ? Promise.reject(new Error('offline')) : http.request(m as never, p, b)) };
  const mk = async (u: string, dev: string, gate = memGate()) => {
    const a = await createOlmAdapter({ userId: userIdFor(u), deviceId: dev, transport: createBackendTransport(be.http(u)), storeName: `${u}-${dev}-rv-${id}`, identityGate: gate });
    await a.sync();
    return a;
  };
  const alice = await mk('alice', 'ALICE1', withRevocationCheck(createIdentityGate(store, () => t), { http: guarded as never, store, now: () => t, maxAgeMs: 60_000 }));
  const bob = await mk('bob', 'BOB1');
  return { be, alice, bob, mk, mem, tick: (ms: number) => { t += ms; } };
}
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);

describe('device revocation (E2EE-50)', () => {
  it('a device removed from the key server gets no new ciphertext, even with an existing session', async () => {
    const { be, alice, bob, tick } = await setup();
    expect(await code(alice.encrypt(bob.identity(), 'hi'))).toBe('ok');
    be.ids.delete('bob'); // server revokes bob's only device
    tick(60_000);
    expect(await code(alice.encrypt(bob.identity(), 'after revoke'))).toBe('NO_DEVICE');
  });

  it('a replaced device (recovery on a new device) is refused and the change is recorded as pending', async () => {
    const { alice, bob, mk, mem, tick } = await setup();
    await alice.encrypt(bob.identity(), 'hi');
    const bob2 = await mk('bob', 'BOB2'); // publishes a new identity, revoking BOB1
    tick(60_000);
    expect(await code(alice.encrypt(bob.identity(), 'to old'))).toBe('IDENTITY_CHANGED');
    expect(mem.get(userIdFor('bob'))!.pendingChange!.deviceId).toBe('BOB2');
    // New device is blocked too until the user re-verifies (no silent trust).
    expect(await code(alice.encrypt(bob2.identity(), 'to new'))).toBe('IDENTITY_CHANGED');
  });

  it('caches the published check for maxAgeMs, then re-checks', async () => {
    const { be, alice, bob, tick } = await setup();
    await alice.encrypt(bob.identity(), 'a');
    const f = be.identityFetches;
    await alice.encrypt(bob.identity(), 'b');
    expect(be.identityFetches).toBe(f);
    tick(60_000);
    await alice.encrypt(bob.identity(), 'c');
    expect(be.identityFetches).toBeGreaterThan(f);
  });

  it('fails closed when the key server cannot be reached for a stale check', async () => {
    let fail = false;
    const { alice, bob, tick } = await setup({ failHttp: () => fail });
    await alice.encrypt(bob.identity(), 'a');
    fail = true;
    tick(60_000);
    expect(await code(alice.encrypt(bob.identity(), 'b'))).toBe('TRANSPORT_FAILED');
  });
});
