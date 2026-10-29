import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { memGate } from './mem-gate.js';
import { FakeBackend } from './fake-backend.js';
import {
  closeCryptoSession, createBackendTransport, createOlmAdapter, deleteLocalCryptoState, hasLocalKeystore,
  keystoreNameFor, localDeviceState, openCryptoSessions, openHistoryStore, userIdFor,
} from '../src/index.js';

let n = 0;
const open = (http: ReturnType<FakeBackend['http']>, user: string, deviceId: string, storeName: string) =>
  createOlmAdapter({ userId: userIdFor(user), deviceId, transport: createBackendTransport(http), storeName, identityGate: memGate() });

describe('logout keeps the device (closeCryptoSession)', () => {
  it('logout -> login as same user reopens the same identity and history, no new-device state', async () => {
    const be = new FakeBackend();
    const http = be.http('dora');
    const store = keystoreNameFor(`u${++n}`);
    const a = await open(http, 'dora', 'DEV1', store);
    await a.sync();
    const id1 = a.identity();
    const h = await openHistoryStore(store);
    await h.put('c1', 1n, { id: 'm1', senderUserId: 'x', senderDeviceId: 'y', text: 'hello', sentAt: 't' });
    expect(openCryptoSessions()).toContain(store);

    closeCryptoSession(store); // logout
    expect(openCryptoSessions()).not.toContain(store);
    await expect(a.sync()).rejects.toThrow(); // adapter is closed
    closeCryptoSession(store); // idempotent

    expect(await hasLocalKeystore(store)).toBe(true);
    expect(await localDeviceState({ http, username: 'dora', storeName: store, deviceId: 'DEV1' })).toBe('existing');
    const b = await open(http, 'dora', 'DEV1', store); // login
    await b.sync();
    expect(b.identity()).toEqual(id1);
    const h2 = await openHistoryStore(store);
    expect((await h2.list('c1')).map((e) => e.text)).toEqual(['hello']);
    closeCryptoSession();
  });

  it('a leftover keystore whose device is no longer the published one needs confirmation', async () => {
    const be = new FakeBackend();
    const http = be.http('eve');
    const s1 = keystoreNameFor(`u${++n}`); const s2 = keystoreNameFor(`u${++n}`);
    await (await open(http, 'eve', 'OLDDEV', s1)).sync();
    closeCryptoSession(s1);
    await (await open(http, 'eve', 'NEWDEV', s2)).sync(); // account moved to another browser
    closeCryptoSession(s2);
    expect(await localDeviceState({ http, username: 'eve', storeName: s1, deviceId: 'OLDDEV' })).toBe('needs-new-device-confirmation');
    expect(await localDeviceState({ http, username: 'eve', storeName: s2, deviceId: 'NEWDEV' })).toBe('existing');
  });

  it('keystores are namespaced per account: another user on the same browser neither sees nor overwrites them', async () => {
    const be = new FakeBackend();
    const ha = be.http('fay'); const hb = be.http('gus');
    const sa = keystoreNameFor(`a${++n}`); const sb = keystoreNameFor(`b${n}`);
    expect(sa).not.toBe(sb);
    const a = await open(ha, 'fay', 'FAYDEV', sa); await a.sync(); const ida = a.identity();
    closeCryptoSession(sa);
    expect(await hasLocalKeystore(sb)).toBe(false);
    expect(await localDeviceState({ http: hb, username: 'gus', storeName: sb })).toBe('fresh');
    const b = await open(hb, 'gus', 'GUSDEV', sb); await b.sync();
    expect(b.identity().curve25519).not.toBe(ida.curve25519);
    closeCryptoSession(sb);
    const a2 = await open(ha, 'fay', 'FAYDEV', sa); await a2.sync();
    expect(a2.identity()).toEqual(ida); // fay's keys untouched by gus
    closeCryptoSession();
  });

  it('closing one store leaves others open; deleteLocalCryptoState still fully wipes', async () => {
    const be = new FakeBackend();
    const http = be.http('hal');
    const s1 = keystoreNameFor(`u${++n}`); const s2 = keystoreNameFor(`u${++n}`);
    await openHistoryStore(s1); const h2 = await openHistoryStore(s2);
    closeCryptoSession(s1);
    expect(openCryptoSessions()).toContain(s2);
    await h2.lastSeq('c');
    closeCryptoSession();
    await (await open(http, 'hal', 'HALDEV', s1)).sync();
    closeCryptoSession(s1);
    await deleteLocalCryptoState(s1);
    expect(await hasLocalKeystore(s1)).toBe(false);
    expect(await localDeviceState({ http, username: 'hal', storeName: s1 })).toBe('needs-new-device-confirmation');
  });

  it('keystoreNameFor rejects ids that could collide or escape the namespace', () => {
    expect(keystoreNameFor('abc-123')).toBe('e2ee-abc-123');
    for (const bad of ['', 'a::b', 'a/b', 'a b', 'x'.repeat(129)]) expect(() => keystoreNameFor(bad)).toThrow();
  });
});
