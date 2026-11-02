import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { FakeGroupServer, member } from './group-fake.js';
import { userIdFor } from '../src/index.js';

const G = 'grp-rr';
const ids = (r: { receipts: { fromUserId: string; upToSeq: string; conversationId: string }[] }) => r.receipts.map((x) => `${x.conversationId}:${x.fromUserId.split(':')[0]}:${x.upToSeq}`);

async function setup() {
  const s = new FakeGroupServer();
  const alice = await member(s, 'alice'); const bob = await member(s, 'bob'); const carol = await member(s, 'carol');
  s.dm('alice', 'bob'); s.dm('alice', 'carol');
  s.create(G, 'alice', ['bob', 'carol']);
  await alice.send(G, 'a1'); await bob.sync(G); await carol.sync(G);
  await bob.send(G, 'b1'); await alice.sync(G); await carol.sync(G);
  await carol.send(G, 'c1'); await alice.sync(G); await bob.sync(G); // every author has verified the others
  return { s, alice, bob, carol };
}

describe('encrypted read receipts', () => {
  it('group: Olm-encrypted to each author\'s verified device, skips self, delivered as receipts, no key sharing', async () => {
    const { s, alice, bob, carol } = await setup();
    const before = s.toDevice.length;
    const r = await bob.groups.sendReadReceipt(G, '7', [userIdFor('alice'), userIdFor('bob'), userIdFor('carol')]);
    expect(r.sent.map((d) => d.userId).sort()).toEqual([userIdFor('alice'), userIdFor('carol')]);
    expect(r.skipped).toEqual([{ userId: userIdFor('bob'), reason: 'self' }]);
    expect(s.toDevice.length - before).toBe(2);
    expect(s.toDevice.slice(before).every((t) => !Buffer.from(t.ciphertext, 'base64').toString().includes('receipt'))).toBe(true); // ciphertext only
    const posts = s.posts;
    const ra = await alice.groups.receiveToDevice(s.drainToDevice('alice'));
    expect(ids(ra)).toEqual([`${G}:@bob:7`]);
    expect(ra.receipts[0]!.ts).toBeTypeOf('number');
    expect(ra.roomKeys).toBe(0); expect(ra.answered).toEqual([]); expect(ra.retry).toEqual([]);
    expect(ids(await carol.groups.receiveToDevice(s.drainToDevice('carol')))).toEqual([`${G}:@bob:7`]);
    expect(s.toDevice.length).toBe(0); // receiving a receipt sent nothing (no key share / key request)
    expect(s.posts).toBe(posts);
  });

  it('monotonic per (conversation, sender): lower or equal upToSeq is ignored', async () => {
    const { s, alice, bob } = await setup();
    const got: string[][] = [];
    for (const n of ['5', '3', '5', '12']) {
      await bob.groups.sendReadReceipt(G, n, [userIdFor('alice')]);
      got.push(ids(await alice.groups.receiveToDevice(s.drainToDevice('alice'))));
    }
    expect(got).toEqual([[`${G}:@bob:5`], [], [], [`${G}:@bob:12`]]); // 12 > 5 numerically, not lexically
  });

  it('only current members: a removed member\'s receipt is dropped, and sending to a non-member is skipped', async () => {
    const { s, alice, bob, carol } = await setup();
    s.remove(G, 'alice', 'carol');
    // carol still has an Olm session with alice; craft the receipt directly
    const env = await carol.adapter.encrypt({ userId: userIdFor('alice'), deviceId: 'ALICE1' }, JSON.stringify({ type: 'receipt', conversationId: G, upToSeq: '9', ts: Date.now() }));
    await s.backend('carol').sendToDevice([env]);
    expect(ids(await alice.groups.receiveToDevice(s.drainToDevice('alice')))).toEqual([]);
    const r = await bob.groups.sendReadReceipt(G, '9', [userIdFor('carol')]);
    expect(r).toEqual({ sent: [], skipped: [{ userId: userIdFor('carol'), reason: 'not_member' }] });
    expect(s.toDevice.length).toBe(0);
  });

  it('1:1 conversation works, malformed receipts are ignored', async () => {
    const { s, alice, bob } = await setup();
    const D = 'dm:alice|bob';
    await bob.groups.sendReadReceipt(D, 4n, [userIdFor('alice')]);
    expect(ids(await alice.groups.receiveToDevice(s.drainToDevice('alice')))).toEqual([`${D}:@bob:4`]);
    for (const bad of [{ type: 'receipt', conversationId: D, upToSeq: '-1', ts: 1 }, { type: 'receipt', conversationId: D, upToSeq: '99', ts: 'x' }, { type: 'receipt', upToSeq: '99', ts: 1 }]) {
      await s.backend('bob').sendToDevice([await bob.adapter.encrypt({ userId: userIdFor('alice'), deviceId: 'ALICE1' }, JSON.stringify(bad))]);
    }
    expect(ids(await alice.groups.receiveToDevice(s.drainToDevice('alice')))).toEqual([]);
    await expect(bob.groups.sendReadReceipt(D, 'abc', [userIdFor('alice')])).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
  });

  it('receipt from an unverified new device is ignored and does not trigger key sharing', async () => {
    const { s, alice } = await setup();
    const bob2 = await member(s, 'bob', 'BOB2');
    await bob2.verifier.refresh(userIdFor('alice'));
    const env = await bob2.adapter.encrypt({ userId: userIdFor('alice'), deviceId: 'ALICE1' }, JSON.stringify({ type: 'receipt', conversationId: G, upToSeq: '50', ts: Date.now() }));
    await s.backend('bob').sendToDevice([env]);
    const r = await alice.groups.receiveToDevice(s.drainToDevice('alice'));
    expect(ids(r)).toEqual([]);
    expect(s.toDevice.length).toBe(0);
  });
});
