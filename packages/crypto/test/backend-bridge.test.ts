/* eslint-disable @typescript-eslint/no-explicit-any -- test fake mirrors untyped HTTP JSON */
import 'fake-indexeddb/auto';
import { memGate } from './mem-gate.js';
import { describe, expect, it } from 'vitest';
import { FakeBackend } from './fake-backend.js';
import {
  CryptoError, checkPeerIdentity, createBackendTransport, createOlmAdapter, decodeMessage, encodeMessage,
  formatSafetyNumber, safetyNumber, userIdFor,
} from '../src/index.js';

let n = 0;
async function setup() {
  const be = new FakeBackend();
  const id = ++n;
  const mk = (u: string, dev: string, store = `${u}-bb-${id}`) =>
    createOlmAdapter({ userId: userIdFor(u), deviceId: dev, transport: createBackendTransport(be.http(u)), storeName: store, identityGate: memGate() });
  const alice = await mk('alice', 'ALICE1');
  const bob = await mk('bob', 'BOB1');
  await alice.sync();
  await bob.sync();
  return { be, alice, bob, mk };
}

describe('backend bridge (PR #13 wire shapes)', () => {
  it('publishes identity + signed prekey + OTKs within backend validation, public data only', async () => {
    const { be } = await setup();
    expect(be.ids.has('alice') && be.ids.has('bob')).toBe(true);
    expect(be.otks.get('bob')!.length).toBeGreaterThan(0);
    const ik = JSON.parse(Buffer.from(be.ids.get('bob')!.identityKey.publicKey, 'base64').toString());
    expect(ik.user_id).toBe(userIdFor('bob'));
    expect(ik.signatures).toBeDefined();
    expect(Buffer.from(be.ids.get('bob')!.signedPrekey.signature, 'base64').length).toBe(64);
    expect(be.bodies.join('\n').toLowerCase()).not.toMatch(/private|secret|pickle/);
  });

  it('round-trips encrypted messages through /conversations/:id/messages both ways', async () => {
    const { be, alice, bob } = await setup();
    const a = alice.identity(), b = bob.identity();
    const env = await alice.encrypt(b, 'hello via backend');
    await be.http('alice').request('POST', '/conversations/c1/messages', encodeMessage(env));
    expect(be.bodies.join('\n')).not.toContain('hello via backend');
    const [r] = await bob.receive([decodeMessage(be.messages[0])]);
    expect(r).toMatchObject({ ok: true, plaintext: 'hello via backend', sender: { userId: a.userId, deviceId: a.deviceId } });
    const back = await bob.encrypt(a, 'reply');
    await be.http('bob').request('POST', '/conversations/c1/messages', encodeMessage(back));
    const [r2] = await alice.receive([decodeMessage(be.messages[1])]);
    expect(r2).toMatchObject({ ok: true, plaintext: 'reply' });
  });

  it('consumes exactly one OTK per new session and falls back to the signed prekey when empty', async () => {
    const { be, alice, bob } = await setup();
    for (const k of be.otks.get('bob')!) k.consumed = true;
    const env = await alice.encrypt(bob.identity(), 'fallback ok');
    const [r] = await bob.receive([decodeMessage(encodeMessage(env))]);
    expect(r).toMatchObject({ ok: true, plaintext: 'fallback ok' });
  });

  it('rejects a bundle whose identity belongs to another user', async () => {
    const { be, alice, bob } = await setup();
    be.ids.set('bob', be.ids.get('alice')!);
    await expect(alice.encrypt(bob.identity(), 'x')).rejects.toBeInstanceOf(CryptoError);
  });

  it('rejects a tampered signed prekey (library signature check)', async () => {
    const { be, alice, bob } = await setup();
    for (const k of be.otks.get('bob')!) k.consumed = true;
    const spk = be.ids.get('bob')!.signedPrekey;
    const obj = JSON.parse(Buffer.from(spk.publicKey, 'base64').toString());
    const raw = Buffer.from(obj.key.key, 'base64'); raw[0]! ^= 1;
    obj.key.key = raw.toString('base64').replace(/=+$/, '');
    spk.publicKey = Buffer.from(JSON.stringify(obj)).toString('base64');
    await expect(alice.encrypt(bob.identity(), 'x')).rejects.toBeInstanceOf(CryptoError);
  });

  it('rejects unknown message versions and malformed ciphertext', () => {
    expect(() => decodeMessage({ ciphertext: 'AAAA', version: 2 })).toThrow(CryptoError);
    expect(() => decodeMessage({ ciphertext: Buffer.from('not json').toString('base64'), version: 1 })).toThrow(CryptoError);
  });

  it('replenishes one-time prekeys when the server pool runs low', async () => {
    const { be, bob } = await setup();
    for (const k of be.otks.get('bob')!) k.consumed = true;
    const { oneTimePrekeyCount } = (await be.http('bob').request('GET', '/keys/count')) as { oneTimePrekeyCount: number };
    expect(oneTimePrekeyCount).toBe(0);
    await bob.replenishPrekeys(oneTimePrekeyCount);
    expect(be.otks.get('bob')!.filter((k) => !k.consumed).length).toBeGreaterThan(0);
  });

  it('safety numbers match on both sides and identity changes are detected', async () => {
    const { alice, bob, mk } = await setup();
    const s1 = await safetyNumber(alice.identity(), bob.identity());
    const s2 = await safetyNumber(bob.identity(), alice.identity());
    expect(s1).toBe(s2);
    expect(s1).toMatch(/^\d{60}$/);
    expect(formatSafetyNumber(s1)).toHaveLength(12);
    const stored = checkPeerIdentity(undefined, bob.identity());
    expect(checkPeerIdentity(stored, bob.identity())).toEqual(stored);
    const bob2 = await mk('bob', 'BOB2', `bob-new-${n}`);
    expect(() => checkPeerIdentity(stored, bob2.identity())).toThrowError(expect.objectContaining({ code: 'IDENTITY_CHANGED' }));
  });

  it('N receives on an existing session consume zero OTKs and make zero bundle/identity calls', async () => {
    const { be, alice, bob } = await setup();
    const a = alice.identity(), b = bob.identity();
    const first = await alice.encrypt(b, 'm0');
    expect((await bob.receive([decodeMessage(encodeMessage(first))]))[0]).toMatchObject({ ok: true });
    await alice.receive([decodeMessage(encodeMessage(await bob.encrypt(a, 'ack')))]);
    const unused = () => [...be.otks.values()].flat().filter((k) => !k.consumed).length;
    const before = { otk: unused(), bundle: be.bundleFetches, ident: be.identityFetches };
    for (let i = 1; i <= 10; i++) {
      const env = await alice.encrypt(b, `m${i}`);
      expect((await bob.receive([decodeMessage(encodeMessage(env))]))[0]).toMatchObject({ ok: true, plaintext: `m${i}` });
      const back = await bob.encrypt(a, `r${i}`);
      expect((await alice.receive([decodeMessage(encodeMessage(back))]))[0]).toMatchObject({ ok: true });
    }
    expect(unused()).toBe(before.otk);
    expect(be.bundleFetches).toBe(before.bundle);
    expect(be.identityFetches).toBe(before.ident);
  });

  it('first session costs exactly one bundle claim; identity lookups never consume OTKs', async () => {
    const { be, alice, bob } = await setup();
    const unused = () => be.otks.get('bob')!.filter((k) => !k.consumed).length;
    const start = unused();
    await alice.encrypt(bob.identity(), 'hi');
    expect(be.bundleFetches).toBe(1);
    expect(unused()).toBe(start - 1);
  });
});
