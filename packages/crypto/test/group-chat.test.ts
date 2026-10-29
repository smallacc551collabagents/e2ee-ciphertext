/* eslint-disable @typescript-eslint/no-explicit-any -- test fake mirrors untyped HTTP JSON */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { FakeGroupServer, member } from './group-fake.js';
import { decodeGroupEnvelope, GROUPS_ENABLED, openHistoryStore, userIdFor, createGroupCrypto, openGroupStateStore } from '../src/index.js';

const G = 'grp-1';
async function world(names = ['alice', 'bob', 'carol']) {
  const s = new FakeGroupServer();
  const m: Record<string, Awaited<ReturnType<typeof member>>> = {};
  for (const u of names) m[u] = await member(s, u);
  for (const a of names) for (const b of names) if (a !== b) s.dm(a, b);
  return { s, m };
}
const sid = (s: FakeGroupServer, seq: number) => (decodeGroupEnvelope(s.groups.get(G)!.msgs.find((x) => x.seq === String(seq))!.ciphertext).content as any).session_id as string;

describe('E2EE group chat (Megolm over Olm, E2EE-53)', () => {
  it('groups are enabled', () => expect(GROUPS_ENABLED).toBe(true));

  it('offline member C gets every message decrypted, in order, after coming back', async () => {
    const { s, m } = await world();
    s.create(G, 'alice', ['bob', 'carol']);
    const carolStore = m.carol!.storeName;
    m.carol!.close(); // offline
    await m.alice!.send(G, 'a1');
    expect((await m.bob!.sync(G)).texts).toEqual(['a1']);
    await m.bob!.send(G, 'b1');
    await m.alice!.send(G, 'a2');
    await m.bob!.send(G, 'b2');
    const carol = await member(s, 'carol', 'CAROL1', { storeName: carolStore }); // back online, persisted store
    const r = await carol.sync(G);
    expect(r.texts).toEqual(['a1', 'b1', 'a2', 'b2']);
    expect(r.res.filter((x) => x.kind === 'message').every((x: any) => x.ok)).toBe(true);
  });

  it('removed member cannot decrypt new messages, even with old keys; admin cannot be removed', async () => {
    const { s, m } = await world();
    s.create(G, 'alice', ['bob', 'carol']);
    await m.alice!.send(G, 'before');
    expect((await m.carol!.sync(G)).texts).toEqual(['before']);
    await expect(async () => s.remove(G, 'bob', 'alice')).rejects.toMatchObject({ status: 403, body: { error: 'cannot_remove_admin' } });
    s.remove(G, 'bob', 'carol');
    await m.alice!.sync(G); // sees member event -> rotate
    await m.alice!.send(G, 'after removal');
    expect(sid(s, 4 /* created, added, before, removed -> next */ + 1)).not.toBe(sid(s, 3));
    // Carol keeps her device + old inbound sessions and somehow obtains the new ciphertext:
    const leaked = s.groups.get(G)!.msgs.filter((x) => x.kind === 'message');
    const res = await m.carol!.groups.receive(G, leaked);
    expect(res.map((x: any) => (x.ok ? x.plaintext : x.code))).toEqual(['before', 'MISSING_ROOM_KEY']);
    // Her key request is refused (not a member, not entitled).
    const bobView = await m.alice!.groups.receiveToDevice(s.drainToDevice('alice'));
    expect(bobView.answered.map((a) => a.status)).toEqual(['refused']);
    expect(s.drainToDevice('carol')).toEqual([]);
    expect((await m.bob!.sync(G)).texts).toEqual(['before', 'after removal']);
  });

  it('new member cannot read history from before joining (no old session shared, key request refused)', async () => {
    const { s, m } = await world(['alice', 'bob', 'carol', 'dave']);
    s.create(G, 'alice', ['bob']);
    await m.alice!.send(G, 'secret history');
    s.add(G, 'bob', 'dave');
    await m.alice!.sync(G);
    await m.alice!.send(G, 'welcome dave');
    // Server hides pre-join seqs; even if leaked, Dave has no key and requests are refused.
    const all = s.groups.get(G)!.msgs.filter((x) => x.kind === 'message');
    await m.dave!.groups.receiveToDevice(s.drainToDevice('dave'));
    const res = await m.dave!.groups.receive(G, all);
    expect(res.map((x: any) => (x.ok ? x.plaintext : x.code))).toEqual(['MISSING_ROOM_KEY', 'welcome dave']);
    const a = await m.alice!.groups.receiveToDevice(s.drainToDevice('alice'));
    expect(a.answered.map((x) => x.status)).toEqual(['refused']);
    expect((await m.dave!.sync(G)).texts).toEqual(['welcome dave']);
  });

  it('rotates the session after 100 messages', async () => {
    const s = new FakeGroupServer();
    const alice = await member(s, 'alice', 'ALICE1', { rotationMessages: 100 });
    const bob = await member(s, 'bob');
    s.dm('alice', 'bob');
    s.create(G, 'alice', ['bob']);
    for (let i = 0; i < 101; i++) await alice.send(G, `n${i}`);
    const ids = s.groups.get(G)!.msgs.filter((x) => x.kind === 'message').map((x) => (decodeGroupEnvelope(x.ciphertext).content as any).session_id);
    expect(new Set(ids.slice(0, 100)).size).toBe(1);
    expect(ids[100]).not.toBe(ids[0]);
    const r = await bob.sync(G);
    expect(r.texts.length).toBe(101);
    expect(r.texts[100]).toBe('n100');
  }, 60_000);

  it('concurrent membership change: stale send gets 409, refetches, rotates, retries; removed member excluded', async () => {
    const { s, m } = await world(['alice', 'bob', 'carol', 'dave']);
    s.create(G, 'alice', ['bob', 'carol']);
    await m.alice!.send(G, 'v1');
    // Alice encrypts for version N while Bob removes Carol and adds Dave at the same moment.
    const be = s.backend('alice');
    let raced = false;
    const real = be.getGroup;
    const alice = createGroupCrypto({
      adapter: m.alice!.adapter,
      backend: { ...be, getGroup: async (id) => { const g = await real(id); if (!raced) { raced = true; s.remove(G, 'bob', 'carol'); s.add(G, 'bob', 'dave'); } return g; } },
    });
    const postsBefore = s.posts;
    await alice.send(G, 'after race');
    expect(s.posts - postsBefore).toBe(1);
    expect((await m.dave!.sync(G)).texts).toEqual(['after race']);
    const leaked = s.groups.get(G)!.msgs.filter((x) => x.kind === 'message');
    await m.carol!.groups.receiveToDevice(s.drainToDevice('carol'));
    const cr = await m.carol!.groups.receive(G, leaked);
    expect(cr.map((x: any) => (x.ok ? x.plaintext : x.code))).toEqual(['v1', 'MISSING_ROOM_KEY']);
  });

  it('leave and re-add: no access while out, access again after re-add', async () => {
    const { s, m } = await world();
    s.create(G, 'alice', ['bob', 'carol']);
    await m.alice!.send(G, 'one');
    expect((await m.carol!.sync(G)).texts).toEqual(['one']);
    s.leave(G, 'carol');
    await m.alice!.sync(G);
    await m.alice!.send(G, 'while away');
    s.add(G, 'bob', 'carol');
    await m.alice!.sync(G);
    await m.alice!.send(G, 'back again');
    await m.carol!.groups.receiveToDevice(s.drainToDevice('carol'));
    const res = await m.carol!.groups.receive(G, s.groups.get(G)!.msgs.filter((x) => x.kind === 'message'));
    expect(res.map((x: any) => (x.ok ? x.plaintext : x.code))).toEqual(['one', 'MISSING_ROOM_KEY', 'back again']);
    await m.alice!.groups.receiveToDevice(s.drainToDevice('alice'));
    expect(s.toDevice.filter((t) => t.recipient === 'carol')).toEqual([]); // request for 'while away' refused
  });

  it('admin leaves -> oldest member becomes admin; last member leaving deletes the group', async () => {
    const { s, m } = await world();
    s.create(G, 'alice', ['bob', 'carol']);
    await m.alice!.send(G, 'hi');
    s.leave(G, 'alice');
    expect(s.groups.get(G)!.admin).toBe('bob');
    await m.bob!.sync(G);
    await m.bob!.send(G, 'bob is admin');
    expect((await m.carol!.sync(G)).texts).toEqual(['hi', 'bob is admin']);
    await expect(m.alice!.send(G, 'x')).rejects.toMatchObject({ status: 404 });
    s.leave(G, 'carol');
    expect(s.leave(G, 'bob')).toEqual({ deleted: true });
    expect(s.groups.has(G)).toBe(false);
    await m.bob!.groups.forget(G);
  });

  it('new device mid-group: key share is withheld until the safety number is accepted, then resent via key request', async () => {
    const { s, m } = await world();
    s.create(G, 'alice', ['bob', 'carol']);
    await m.alice!.send(G, 'first');
    m.bob!.close(); // Bob offline; 'second' and its key share are queued for BOB1
    await m.alice!.send(G, 'second');
    const bob2 = await member(s, 'bob', 'BOB2'); // incognito / new device: BOB1's queued key share is dropped
    const r1 = await bob2.sync(G);
    expect(r1.texts).toEqual([]);
    expect(r1.res.filter((x) => x.kind === 'message').map((x: any) => x.code)).toEqual(['MISSING_ROOM_KEY', 'MISSING_ROOM_KEY']);
    expect(bob2.groups.isWaiting(G)).toBe(true);
    // Alice gets Bob2's key requests, but Bob's identity changed and is not accepted: deferred, nothing sent.
    const a1 = await m.alice!.groups.receiveToDevice(s.drainToDevice('alice'));
    expect(a1.answered.map((x) => x.status)).toEqual(['deferred']);
    const sendRes = await m.alice!.send(G, 'third');
    expect(sendRes.pending).toEqual([userIdFor('bob')]);
    // Alice accepts the new safety number.
    const ref = await m.alice!.verifier.refresh(userIdFor('bob'));
    expect(ref.status).toBe('changed');
    await m.alice!.verifier.acceptNewIdentity(ref.current!);
    const rs = await m.alice!.groups.reshare(G);
    expect(rs.pending).toEqual([]);
    expect(rs.answered).toEqual(['sent']);
    const r2 = await bob2.sync(G);
    expect(r2.texts).toEqual(['first', 'second']);
    // 'third' was sent while Bob was pending; Bob2 requests it, Alice (Bob now accepted + entitled) answers.
    const a2 = await m.alice!.groups.receiveToDevice(s.drainToDevice('alice'));
    expect(a2.answered.map((x) => x.status)).toEqual(['sent']);
    const r3 = await bob2.sync(G);
    expect(r3.texts).toEqual(['third']);
    expect(bob2.groups.isWaiting(G)).toBe(false);
    expect((await m.carol!.sync(G)).texts).toEqual(['first', 'second', 'third']);
  });

  it('new device after sender reload: accept + reshare(accepted) pushes old sessions to the new device (no request needed)', async () => {
    const s = new FakeGroupServer();
    const st = await openGroupStateStore(`alice-groups-${Date.now()}`);
    const alice = await member(s, 'alice', 'ALICE1', { state: st });
    const bob = await member(s, 'bob'); await member(s, 'carol');
    for (const a of ['alice', 'bob', 'carol']) for (const b of ['alice', 'bob', 'carol']) if (a !== b) s.dm(a, b);
    s.create(G, 'alice', ['bob', 'carol']);
    await alice.send(G, 'first');
    bob.close();
    const bob2 = await member(s, 'bob', 'BOB2');
    // Alice sends while Bob's new identity is unaccepted: Bob is pending, share withheld.
    expect((await alice.send(G, 'pending-time')).pending).toEqual([userIdFor('bob')]);
    expect((await bob2.sync(G)).texts).toEqual([]);
    // Bob2's key requests reach Alice, get deferred in memory... then Alice reloads (memory lost, state store kept).
    await alice.groups.receiveToDevice(s.drainToDevice('alice'));
    const alice2 = await member(s, 'alice', 'ALICE1', { storeName: alice.storeName, state: st });
    const ref = await alice2.verifier.refresh(userIdFor('bob'));
    await alice2.verifier.acceptNewIdentity(ref.current!);
    const rs = await alice2.groups.reshare(G, [userIdFor('bob')]);
    expect(rs.answered.length).toBeGreaterThan(0);
    expect(rs.answered.every((x) => x === 'sent')).toBe(true);
    const r = await bob2.sync(G);
    expect(r.texts).toEqual(['first', 'pending-time']);
    expect(bob2.groups.isWaiting(G)).toBe(false);
  });

  it('member first seen via the group: TOFU shares immediately; a later device change is held until acceptMemberIdentity, which pushes older keys', async () => {
    const s = new FakeGroupServer();
    const alice = await member(s, 'alice'); const bob = await member(s, 'bob'); const dan = await member(s, 'dan');
    s.dm('bob', 'alice'); s.dm('bob', 'dan'); // alice and dan share only the group
    s.create(G, 'bob', ['alice', 'dan']);
    await alice.send(G, 'tofu-1');
    expect((await dan.sync(G)).texts).toEqual(['tofu-1']); // first contact: trusted on first use
    expect(await alice.groups.getPendingIdentities(G)).toEqual([]);
    dan.close();
    const dan2 = await member(s, 'dan', 'DAN2');
    const rf = await alice.groups.refreshMembers(G); // membership refresh / poll detects the change
    expect(rf.pending).toEqual([userIdFor('dan')]);
    expect(rf.identities.map((x) => x.userId)).toEqual([userIdFor('dan')]);
    expect((await alice.send(G, 'held')).pending).toEqual([userIdFor('dan')]);
    await dan2.sync(G);
    await alice.groups.receiveToDevice(s.drainToDevice('alice')); // dan2's key requests: deferred, nothing sent
    expect(s.toDevice.filter((t) => t.recipient === 'dan')).toEqual([]);
    const acc = await alice.groups.acceptMemberIdentity(G, userIdFor('dan'));
    expect(acc.pending).toEqual([]);
    expect(await alice.groups.getPendingIdentities(G)).toEqual([]);
    const r = await dan2.sync(G);
    expect(r.texts).toContain('held');
    expect(dan2.groups.isWaiting(G)).toBe(false);
    void bob;
  });

  it('decrypted group messages are saved to the encrypted history store before receive() returns', async () => {
    const { s, m } = await world(['alice', 'bob']);
    s.create(G, 'alice', ['bob']);
    await m.alice!.send(G, 'saved');
    const history = await openHistoryStore(`bob-hist-grp-${Date.now()}`);
    const g = createGroupCrypto({ adapter: m.bob!.adapter, backend: s.backend('bob'), history });
    await g.receiveToDevice(s.drainToDevice('bob'));
    await g.receive(G, s.fetch(G, 'bob'));
    expect((await history.list(G)).map((h) => h.text)).toEqual(['saved']);
    history.close();
  });

  it('attachment descriptors ride inside the Megolm message unchanged', async () => {
    const { s, m } = await world(['alice', 'bob']);
    s.create(G, 'alice', ['bob']);
    const desc = JSON.stringify({ t: 'attachment', key: 'per-file-key-b64', iv: 'iv', sha256: 'h', blobId: 'b1' });
    await m.alice!.send(G, desc);
    expect((await m.bob!.sync(G)).texts).toEqual([desc]);
  });

  it('server rules: only people with a 1:1 can be added; cap 50', async () => {
    const { s } = await world(['alice', 'bob']);
    expect(() => s.create(G, 'alice', ['zed'])).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => s.create(G, 'alice', Array.from({ length: 50 }, (_, i) => `u${i}`))).toThrow(expect.objectContaining({ status: 409 }));
  });
});
