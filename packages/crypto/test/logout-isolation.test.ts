import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { FakeGroupServer, member } from './group-fake.js';
import { closeCryptoSession, createGroupCrypto, openCryptoSessions, openGroupStateStore } from '../src/index.js';

const G = 'grp-iso';
describe('logout isolation (P0: same browser, multiple accounts)', () => {
  it('closeCryptoSession() tears down group crypto: no send / answer / receive with the previous user state', async () => {
    const s = new FakeGroupServer();
    const x = await member(s, 'xuser'); await member(s, 'yuser');
    s.dm('xuser', 'yuser'); s.create(G, 'xuser', ['yuser']);
    await x.send(G, 'before-logout');
    expect(openCryptoSessions().length).toBeGreaterThan(0);
    closeCryptoSession();
    expect(openCryptoSessions()).toEqual([]);
    await expect(x.groups.send(G, 'phantom')).rejects.toMatchObject({ code: 'NOT_INITIALIZED' });
    await expect(x.groups.receiveToDevice([])).rejects.toMatchObject({ code: 'NOT_INITIALIZED' });
    await expect(x.groups.reshare(G)).rejects.toMatchObject({ code: 'NOT_INITIALIZED' });
    expect(x.groups.isWaiting(G)).toBe(false);
    const msgs = s.groups.get(G)!.msgs.filter((m) => m.kind !== 'member_event');
    expect(msgs.length).toBe(1);
  });

  it('refuses to build group crypto for a different owner than the adapter', async () => {
    const s = new FakeGroupServer();
    const x = await member(s, 'xown');
    expect(() => createGroupCrypto({ adapter: x.adapter, backend: s.backend('xown'), ownerUserId: '@someone-else:e2ee.local' })).toThrow(/owner/);
  });

  it('group state stores are per user and closed by closeCryptoSession(storeName)', async () => {
    const a = await openGroupStateStore('e2ee-userA-groups');
    const b = await openGroupStateStore('e2ee-userB-groups');
    await a.set('g', { sessionMembers: { s1: ['x'] } });
    expect(await b.get('g')).toBeUndefined();
    expect(openCryptoSessions()).toEqual(expect.arrayContaining(['e2ee-userA', 'e2ee-userB']));
    closeCryptoSession('e2ee-userA');
    expect(openCryptoSessions()).not.toContain('e2ee-userA');
    b.close();
  });
});
