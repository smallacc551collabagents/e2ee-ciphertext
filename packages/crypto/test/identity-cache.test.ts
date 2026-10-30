/* eslint-disable @typescript-eslint/no-explicit-any -- test fake mirrors untyped HTTP JSON */
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { FakeGroupServer, member } from './group-fake.js';
import { fetchIdentities, userIdFor } from '../src/index.js';

const G = 'grp-idc';
async function world(names = ['alice', 'bob', 'carol', 'dave'], batch = false) {
  const s = new FakeGroupServer();
  s.keys.batchEnabled = batch;
  const m: Record<string, Awaited<ReturnType<typeof member>>> = {};
  for (const u of names) m[u] = await member(s, u);
  for (const a of names) for (const b of names) if (a !== b) s.dm(a, b);
  s.create(G, 'alice', names.slice(1));
  return { s, m };
}
const gets = (s: FakeGroupServer) => s.keys.identityFetches;

describe('group send: cached member identities, batched lookups', () => {
  it('5 sends to 3 members: was 30 GET /keys/identity; now 1 batch call per send, or 3 deduped GETs before the batch deploy', async () => {
    for (const batch of [true, false]) {
      const { s, m } = await world(undefined, batch);
      await m.alice!.send(G, 'warm');
      const g0 = gets(s); const b0 = s.keys.batchFetches;
      for (let i = 0; i < 5; i++) await m.alice!.send(G, `m${i}`);
      // The test fake runs the revocation check with maxAgeMs 0 (every send re-confirms); production caches 5 min.
      if (batch) { expect(gets(s) - g0).toBe(0); expect(s.keys.batchFetches - b0).toBe(5); }
      else expect(gets(s) - g0).toBe(15);
      for (const u of ['bob', 'carol', 'dave']) expect((await m[u]!.sync(G)).texts).toEqual(['warm', 'm0', 'm1', 'm2', 'm3', 'm4']);
    }
  });

  it('re-queries member devices only on membership change, pendingChange, 409 or a new-device signal', async () => {
    const { s, m } = await world();
    const spy = vi.spyOn(m.alice!.adapter as any, 'shareGroupKey');
    const rq = () => (spy.mock.calls.at(-1)![2] as any).requery;
    await m.alice!.send(G, 'a'); expect(rq()).toBe(true);
    await m.alice!.send(G, 'b'); expect(rq()).toBe(false);
    m.alice!.groups.markIdentitiesChanged();
    await m.alice!.send(G, 'c'); expect(rq()).toBe(true);
    await m.alice!.send(G, 'd'); expect(rq()).toBe(false);
    // Membership changed behind our back: the server 409s, we refetch the group and re-verify.
    s.remove(G, 'alice', 'dave');
    const posts = s.posts;
    await m.alice!.send(G, 'e');
    expect(s.posts).toBe(posts + 1);
    expect(rq()).toBe(true);
    expect((await m.bob!.sync(G)).texts.at(-1)).toBe('e');
    expect((await m.dave!.sync(G).catch(() => ({ texts: [] as string[] }))).texts).not.toContain('e');
    const calls = spy.mock.calls.length;
    await m.alice!.send(G, 'f'); // group not re-fetched / re-verified when nothing changed
    expect(spy.mock.calls.length).toBe(calls + 1);
    expect(rq()).toBe(false);
  });

  it('identity gate keeps its security with the cache: a replaced device goes to pendingChange and gets no keys until accepted', async () => {
    const { s, m } = await world(undefined, true);
    await m.alice!.send(G, 'one');
    await m.alice!.send(G, 'two'); // cache warm
    const bob2 = await member(s, 'bob', 'BOB2'); // new browser; alice gets no signal
    const r = await m.alice!.send(G, 'three');
    expect(r.pending).toContain(userIdFor('bob'));
    expect((await m.alice!.peers.get(userIdFor('bob')))?.pendingChange?.deviceId).toBe('BOB2');
    expect(s.toDevice.filter((t) => t.recipient === 'bob')).toEqual([]);
    const r4 = await m.alice!.send(G, 'four'); // still pending: re-checked, still withheld
    expect(r4.pending).toContain(userIdFor('bob'));
    expect(s.toDevice.filter((t) => t.recipient === 'bob')).toEqual([]);
    expect((await m.carol!.sync(G)).texts).toEqual(['one', 'two', 'three', 'four']);
    await m.alice!.groups.acceptMemberIdentity(G, userIdFor('bob'));
    const r5 = await m.alice!.send(G, 'five');
    expect(r5.pending).toEqual([]);
    expect((await bob2.sync(G)).texts).toContain('five');
  });

  it('fetchIdentities: one batch request, 404 falls back to deduped parallel GETs (remembered), missing users are null', async () => {
    const seen: string[] = [];
    const mk = (batch: boolean) => ({
      request: async (method: string, path: string, body?: any) => {
        seen.push(`${method} ${path}`);
        if (path === '/keys/identity/batch') {
          if (!batch) throw Object.assign(new Error('nf'), { status: 404 });
          return { identities: body.usernames.filter((u: string) => u !== 'zed').map((u: string) => ({ userId: `id-${u}`, username: u, identityKey: { publicKey: 'AAAA', version: 1 }, signedPrekey: { keyId: 1, publicKey: 'AAAA', signature: 'AAAA', version: 1 } })).concat([{ userId: 'x', username: 'evil', identityKey: { publicKey: 'AAAA', version: 1 }, signedPrekey: { keyId: 1, publicKey: 'AAAA', signature: 'AAAA', version: 1 } }]), missing: body.usernames.filter((u: string) => u === 'zed') };
        }
        if (path.endsWith('/zed')) throw Object.assign(new Error('nf'), { status: 404 });
        return { username: path.split('/').pop(), k: 1 };
      },
    });
    const a = await fetchIdentities(mk(true), ['bob', 'carol', 'bob', 'zed']);
    expect(seen).toEqual(['POST /keys/identity/batch']);
    expect([...a.keys()]).toEqual(['bob', 'carol', 'zed']);
    expect(a.get('zed')).toBeNull();
    seen.length = 0;
    const h = mk(false);
    const b = await fetchIdentities(h, ['bob', 'carol', 'bob', 'zed']);
    expect(seen.sort()).toEqual(['GET /keys/identity/bob', 'GET /keys/identity/carol', 'GET /keys/identity/zed', 'POST /keys/identity/batch']);
    expect(b.get('zed')).toBeNull();
    seen.length = 0;
    await fetchIdentities(h, ['bob']);
    expect(seen).toEqual(['GET /keys/identity/bob']); // 404 remembered per client
  });
});

describe('fetchIdentities chunking (PR #87 contract)', () => {
  it('chunks at IDENTITY_BATCH_MAX=50, maps missing to null, validates with shared schemas', async () => {
    const calls: number[] = [];
    const http = { async request(_m: string, _p: string, body?: unknown) {
      const u = (body as { usernames: string[] }).usernames; calls.push(u.length);
      const have = u.filter((n) => !n.endsWith('x'));
      return { identities: have.map((n) => ({ userId: `id-${n}`, username: n.toUpperCase(), identityKey: { publicKey: 'AAAA', version: 1 }, signedPrekey: { keyId: 1, publicKey: 'AAAA', signature: 'AAAA', version: 1 } })), missing: u.filter((n) => n.endsWith('x')) };
    } };
    const names = Array.from({ length: 120 }, (_, i) => `user${i}${i === 7 ? 'x' : ''}`);
    const r = await fetchIdentities(http as never, [...names, names[0]!]);
    expect(calls).toEqual([50, 50, 20]);
    expect(r.get('user7x')).toBeNull();
    expect(r.get('user8')).not.toBeNull();
  });
});
