/* eslint-disable @typescript-eslint/no-explicit-any -- inspects raw HTTP bodies and IndexedDB records */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { FakeBackend } from './fake-backend.js';
import {
  createBackendTransport, createIdentityGate, createOlmAdapter, decodeMessage, encodeMessage, userIdFor, type StoredPeer,
} from '../src/index.js';

// E2EE-29 acceptance: two clients establish sessions; state survives reload; private keys never leave the client.
let n = 0;
const gate = () => {
  const mem = new Map<string, StoredPeer>();
  return createIdentityGate({ get: async (u) => mem.get(u), set: async (u, v) => void mem.set(u, v) });
};

async function setup() {
  const be = new FakeBackend();
  const id = ++n;
  const open = async (u: string, dev: string) => {
    const a = await createOlmAdapter({ userId: userIdFor(u), deviceId: dev, transport: createBackendTransport(be.http(u)), storeName: `${u}-ba-${id}`, identityGate: gate() });
    await a.sync();
    return a;
  };
  return { be, open, id };
}

function leafKeys(v: unknown, path = '', out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => leafKeys(x, `${path}[]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) leafKeys(x, path ? `${path}.${k}` : k, out);
  else if (path) out.add(path);
  return out;
}

describe('browser crypto adapter acceptance (E2EE-29)', () => {
  it('two clients establish a session both ways, and it survives reload of both without new prekeys', async () => {
    const { be, open } = await setup();
    let alice = await open('alice', 'ALICE1');
    let bob = await open('bob', 'BOB1');
    const send = async (from: any, user: string, to: any, text: string) => {
      await be.http(user).request('POST', '/conversations/c1/messages', encodeMessage(await from.encrypt(to, text)));
      return decodeMessage(be.messages[be.messages.length - 1]);
    };
    expect((await bob.receive([await send(alice, 'alice', bob.identity(), 'hi bob')]))[0]).toMatchObject({ ok: true, plaintext: 'hi bob' });
    expect((await alice.receive([await send(bob, 'bob', alice.identity(), 'hi alice')]))[0]).toMatchObject({ ok: true, plaintext: 'hi alice' });
    const ids = [alice.identity(), bob.identity()];
    const claims = be.bundleFetches;

    alice.close(); bob.close(); // page reload
    alice = await open('alice', 'ALICE1');
    bob = await open('bob', 'BOB1');
    expect([alice.identity(), bob.identity()]).toEqual(ids); // same identity keys, no re-publish of a new identity
    expect((await bob.receive([await send(alice, 'alice', bob.identity(), 'after reload')]))[0]).toMatchObject({ ok: true, plaintext: 'after reload' });
    expect((await alice.receive([await send(bob, 'bob', alice.identity(), 'still here')]))[0]).toMatchObject({ ok: true, plaintext: 'still here' });
    expect(be.bundleFetches).toBe(claims); // existing sessions reused
    alice.close(); bob.close();
  });

  it('private keys never leave the client: every outbound body is public keys, signatures or ciphertext only', async () => {
    const { be, open } = await setup();
    const alice = await open('alice', 'ALICE1');
    const bob = await open('bob', 'BOB1');
    await be.http('alice').request('POST', '/conversations/c1/messages', encodeMessage(await alice.encrypt(bob.identity(), 'x')));
    const allowed = new Set([
      'identityKey.publicKey', 'identityKey.version',
      'signedPrekey.keyId', 'signedPrekey.publicKey', 'signedPrekey.signature', 'signedPrekey.version',
      'oneTimePrekeys[].keyId', 'oneTimePrekeys[].publicKey', 'oneTimePrekeys[].version',
      'clientMsgId', 'ciphertext', 'version',
    ]);
    const seen = new Set<string>();
    for (const b of be.bodies) for (const k of leafKeys(JSON.parse(b))) seen.add(k);
    expect([...seen].filter((k) => !allowed.has(k))).toEqual([]);
    // Published key blobs decode to public material only.
    const blobs = be.bodies.flatMap((b) => [...JSON.stringify(JSON.parse(b)).matchAll(/"publicKey":"([^"]+)"/g)].map((m) => Buffer.from(m[1]!, 'base64').toString('latin1')));
    // Check field NAMES only: random base64 key values can contain e.g. "seed" by chance (CI flake on #39).
    const names: string[] = [];
    const walk = (v: unknown): void => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { names.push(k); walk(x); } };
    for (const blob of blobs) { let parsed: unknown; try { parsed = JSON.parse(blob); } catch { parsed = undefined; } if (parsed === undefined) expect(blob.toLowerCase()).not.toMatch(/private|secret|pickle/); else walk(parsed); }
    expect(names.join('\n').toLowerCase()).not.toMatch(/private|secret|pickle|seed/);
    alice.close(); bob.close();
  });

  it('the at-rest wrapping key is a non-extractable CryptoKey and the store key is only kept wrapped', async () => {
    const { open, id } = await setup();
    const a = await open('alice', 'ALICE1');
    a.close();
    const db = await new Promise<IDBDatabase>((res) => { const r = indexedDB.open(`alice-ba-${id}-wrap`); r.onsuccess = () => res(r.result); });
    const rec: any = await new Promise((res) => { const r = db.transaction('keys').objectStore('keys').get('store-key-v1'); r.onsuccess = () => res(r.result); });
    db.close();
    expect(rec.wrappingKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', rec.wrappingKey)).rejects.toBeDefined();
    expect(rec.wrapped.byteLength).toBe(32 + 16); // AES-GCM(32-byte store key) + tag; raw key never stored
  });
});
