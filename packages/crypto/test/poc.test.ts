import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { CryptoError, createOlmAdapter, type CiphertextEnvelope, type CryptoAdapter } from '../src/index.js';
import { InMemoryRelay } from './relay.js';

let n = 0;
async function pair() {
  const relay = new InMemoryRelay();
  const id = ++n;
  const aliceAddr = { userId: '@alice:e2ee.test', deviceId: 'ALICE1' };
  const bobAddr = { userId: '@bob:e2ee.test', deviceId: 'BOB1' };
  const mk = (a: typeof aliceAddr, name: string) =>
    createOlmAdapter({ ...a, transport: relay.transport(), storeName: `${name}-${id}` });
  const alice = await mk(aliceAddr, 'alice');
  const bob = await mk(bobAddr, 'bob');
  await alice.sync();
  await bob.sync();
  return { relay, alice, bob, aliceAddr, bobAddr, mk };
}

function tamper(env: CiphertextEnvelope): CiphertextEnvelope {
  const c = structuredClone(env.content) as { ciphertext: Record<string, { body: string; type: number }> };
  const k = Object.keys(c.ciphertext)[0]!;
  const body = c.ciphertext[k]!.body;
  const i = Math.floor(body.length / 2);
  c.ciphertext[k]!.body = body.slice(0, i) + (body[i] === 'A' ? 'B' : 'A') + body.slice(i + 1);
  return { ...env, content: c };
}

async function one(adapter: CryptoAdapter, env: CiphertextEnvelope) {
  const [r] = await adapter.receive([env]);
  return r!;
}

describe('two-client Olm PoC (matrix-sdk-crypto-wasm / vodozemac)', () => {
  it('publishes a signed public bundle and one-time prekeys only', async () => {
    const { relay, bob, bobAddr } = await pair();
    const dk = relay.deviceKeys.get(bobAddr.userId)?.get(bobAddr.deviceId) as Record<string, unknown>;
    expect(dk).toBeDefined();
    expect((dk.keys as Record<string, string>)[`ed25519:${bobAddr.deviceId}`]).toBe(bob.identity().ed25519);
    expect(dk.signatures).toBeDefined();
    expect(relay.oneTimeKeys.get(`${bobAddr.userId}|${bobAddr.deviceId}`)!.length).toBeGreaterThan(0);
    const all = relay.seenBodies.join('\n').toLowerCase();
    expect(all).not.toMatch(/private|secret|pickle/);
  });

  it('establishes a session, encrypts, relays and decrypts in both directions', async () => {
    const { relay, alice, bob, aliceAddr, bobAddr } = await pair();
    const env = await alice.encrypt(bobAddr, 'hello bob');
    expect(JSON.stringify(env)).not.toContain('hello bob');
    relay.deliver(env);
    const [r] = await bob.receive(relay.drain(bobAddr));
    expect(r).toMatchObject({ ok: true, plaintext: 'hello bob', sender: aliceAddr, senderCurve25519: alice.identity().curve25519 });

    const back = await bob.encrypt(aliceAddr, 'hi alice');
    relay.deliver(back);
    const [r2] = await alice.receive(relay.drain(aliceAddr));
    expect(r2).toMatchObject({ ok: true, plaintext: 'hi alice' });
    expect(relay.seenBodies.join('\n')).not.toMatch(/hello bob|hi alice/);
  });

  it('claims each one-time prekey at most once', async () => {
    const { relay, alice, bobAddr } = await pair();
    await alice.encrypt(bobAddr, 'x');
    await alice.encrypt(bobAddr, 'y');
    expect(relay.claimed.length).toBe(1);
    expect(new Set(relay.claimed).size).toBe(relay.claimed.length);
  });

  it('rejects tampered ciphertext (pre-key and normal messages) without breaking the session', async () => {
    const { alice, bob, aliceAddr, bobAddr } = await pair();
    const first = await alice.encrypt(bobAddr, 'm1');
    const bad = await one(bob, tamper(first));
    expect(bad.ok).toBe(false);
    expect(await one(bob, first)).toMatchObject({ ok: true, plaintext: 'm1' });

    // Normal (non-pre-key) message after the session is confirmed.
    await one(alice, await bob.encrypt(aliceAddr, 'ack'));
    const m2 = await alice.encrypt(bobAddr, 'm2');
    const bad2 = await one(bob, tamper(m2));
    expect(bad2.ok).toBe(false);
    if (!bad2.ok) {
      expect(bad2.error).toBeInstanceOf(CryptoError);
      expect(bad2.error.code).toBe('DECRYPT_FAILED');
    }
    expect(await one(bob, m2)).toMatchObject({ ok: true, plaintext: 'm2' });
  });

  it('rejects a replayed envelope', async () => {
    const { alice, bob, aliceAddr, bobAddr } = await pair();
    const m1 = await alice.encrypt(bobAddr, 'once');
    expect((await one(bob, m1)).ok).toBe(true);
    expect((await one(bob, m1)).ok).toBe(false);
    await one(alice, await bob.encrypt(aliceAddr, 'ack'));
    const m2 = await alice.encrypt(bobAddr, 'once more');
    expect((await one(bob, m2)).ok).toBe(true);
    expect((await one(bob, m2)).ok).toBe(false);
  });

  it('rejects misaddressed envelopes and spoofed sender devices', async () => {
    const { alice, bob, bobAddr } = await pair();
    const env = await alice.encrypt(bobAddr, 'to bob');
    const mis = await one(bob, { ...env, recipient: { userId: bobAddr.userId, deviceId: 'OTHER' } });
    expect(mis.ok === false && mis.error.code).toBe('INVALID_ENVELOPE');
    const spoof = await one(bob, { ...env, sender: { userId: env.sender.userId, deviceId: 'FAKE' } });
    expect(spoof.ok === false && spoof.error.code).toBe('IDENTITY_CHANGED');
  });

  it('refuses to encrypt to a bundle whose signature does not verify', async () => {
    const { relay, alice, bobAddr } = await pair();
    const dk = relay.deviceKeys.get(bobAddr.userId)!.get(bobAddr.deviceId)!;
    const keys = dk.keys as Record<string, string>;
    const ck = `curve25519:${bobAddr.deviceId}`;
    keys[ck] = keys[ck]!.slice(0, -2) + (keys[ck]!.endsWith('AA') ? 'BB' : 'AA');
    await expect(alice.encrypt(bobAddr, 'nope')).rejects.toMatchObject({ code: 'NO_DEVICE' });
  });

  it('restores identity and session state after reload (encrypted IndexedDB store)', async () => {
    const { relay, alice, bob, aliceAddr, bobAddr, mk } = await pair();
    expect((await one(bob, await alice.encrypt(bobAddr, 'before'))).ok).toBe(true);
    const aliceId = alice.identity();
    const bobId = bob.identity();
    alice.close();
    bob.close();
    await expect(alice.encrypt(bobAddr, 'closed')).rejects.toMatchObject({ code: 'NOT_INITIALIZED' });

    const storeA = `alice-${n}`;
    const storeB = `bob-${n}`;
    const alice2 = await mk(aliceAddr, storeA.replace(/-\d+$/, ''));
    const bob2 = await mk(bobAddr, storeB.replace(/-\d+$/, ''));
    expect(alice2.identity()).toEqual(aliceId);
    expect(bob2.identity()).toEqual(bobId);

    const claimsBefore = relay.claimed.length;
    expect(await one(bob2, await alice2.encrypt(bobAddr, 'after reload'))).toMatchObject({ ok: true, plaintext: 'after reload' });
    expect(await one(alice2, await bob2.encrypt(aliceAddr, 'reply'))).toMatchObject({ ok: true, plaintext: 'reply' });
    expect(relay.claimed.length).toBe(claimsBefore); // existing session reused, no new prekey
    alice2.close();
    bob2.close();
  });
});
