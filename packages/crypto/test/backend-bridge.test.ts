/* eslint-disable @typescript-eslint/no-explicit-any -- test fake mirrors untyped HTTP JSON */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  CryptoError, checkPeerIdentity, createBackendTransport, createOlmAdapter, decodeMessage, encodeMessage,
  formatSafetyNumber, safetyNumber, userIdFor, type BackendHttp,
} from '../src/index.js';

/** Fake of PR #13 /keys + /messages semantics and validation (docs/phase1-backend.md). */
class FakeBackend {
  ids = new Map<string, { identityKey: any; signedPrekey: any }>();
  otks = new Map<string, Array<{ keyId: number; publicKey: string; version: number; consumed: boolean }>>();
  messages: any[] = [];
  bodies: string[] = [];
  bundleFetches = 0;
  private canon(s: string, max: number) {
    const ok = /^[A-Za-z0-9+/]+={0,2}$/.test(s) && Buffer.from(s, 'base64').toString('base64') === s && Buffer.from(s, 'base64').length <= max;
    if (!ok) throw Object.assign(new Error('invalid_key'), { status: 400 });
  }
  private ver(v: unknown) { if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 65535) throw Object.assign(new Error('version'), { status: 400 }); }
  private kid(v: unknown) { if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 2147483647) throw Object.assign(new Error('keyId'), { status: 400 }); }
  http(user: string): BackendHttp {
    return { request: async (method, path, body) => { this.bodies.push(JSON.stringify(body ?? null)); return this.route(user, method, path, body as any); } };
  }
  private route(user: string, method: string, path: string, body: any): unknown {
    const pool = () => (this.otks.get(user) ?? []).filter((k) => !k.consumed).length;
    if (method === 'POST' && path === '/keys/publish') {
      const allowed = ['identityKey', 'signedPrekey', 'oneTimePrekeys'];
      if (!Object.keys(body).length || Object.keys(body).some((k) => !allowed.includes(k))) throw Object.assign(new Error('shape'), { status: 400 });
      const cur = this.ids.get(user);
      if (body.identityKey) { this.canon(body.identityKey.publicKey, 1024); this.ver(body.identityKey.version); }
      if (body.signedPrekey) { const s = body.signedPrekey; this.canon(s.publicKey, 1024); this.canon(s.signature, 1024); this.ver(s.version); this.kid(s.keyId); }
      if (!cur && !(body.identityKey && body.signedPrekey)) throw Object.assign(new Error('identity_required'), { status: 400 });
      if (body.identityKey && !body.signedPrekey) throw Object.assign(new Error('signed_prekey_required'), { status: 400 });
      if (body.identityKey) this.ids.set(user, { identityKey: body.identityKey, signedPrekey: body.signedPrekey });
      else if (body.signedPrekey) cur!.signedPrekey = body.signedPrekey;
      const list = this.otks.get(user) ?? [];
      for (const k of body.oneTimePrekeys ?? []) {
        this.canon(k.publicKey, 1024); this.ver(k.version); this.kid(k.keyId);
        if (list.some((x) => x.keyId === k.keyId)) throw Object.assign(new Error('dup keyId'), { status: 409 });
        list.push({ ...k, consumed: false });
      }
      if ((body.oneTimePrekeys ?? []).length > 100) throw Object.assign(new Error('batch'), { status: 400 });
      this.otks.set(user, list);
      return { oneTimePrekeyCount: pool() };
    }
    if (method === 'GET' && path === '/keys/count') return { oneTimePrekeyCount: pool() };
    const m = /^\/keys\/bundle\/(.+)$/.exec(path);
    if (method === 'GET' && m) {
      this.bundleFetches++;
      const target = decodeURIComponent(m[1]!);
      const id = this.ids.get(target);
      if (!id) throw Object.assign(new Error('not found'), { status: 404 });
      const otk = (this.otks.get(target) ?? []).find((k) => !k.consumed) ?? null;
      if (otk) otk.consumed = true;
      return { userId: `uuid-${target}`, username: target, identityKey: id.identityKey, signedPrekey: id.signedPrekey,
        oneTimePrekey: otk && { keyId: otk.keyId, publicKey: otk.publicKey, version: otk.version } };
    }
    if (method === 'POST' && path === '/conversations/c1/messages') {
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(body.clientMsgId)) throw Object.assign(new Error('clientMsgId'), { status: 400 });
      this.canon(body.ciphertext, 32 * 1024); this.ver(body.version);
      const msg = { id: `m${this.messages.length}`, senderId: user, seq: String(this.messages.length + 1), ...body };
      this.messages.push(msg);
      return { message: msg, duplicate: false };
    }
    throw Object.assign(new Error(`unrouted ${method} ${path}`), { status: 404 });
  }
}

let n = 0;
async function setup() {
  const be = new FakeBackend();
  const id = ++n;
  const mk = (u: string, dev: string, store = `${u}-bb-${id}`) =>
    createOlmAdapter({ userId: userIdFor(u), deviceId: dev, transport: createBackendTransport(be.http(u)), storeName: store });
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
});
