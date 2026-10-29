import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { memGate } from './mem-gate.js';
import { FakeBackend } from './fake-backend.js';
import { classifyIdentityChange, fromBundle, createBackendTransport, createOlmAdapter, hasLocalKeystore, localDeviceState, userIdFor } from '../src/index.js';

let n = 0;
describe('new-device detection (E2EE-79)', () => {
  it('fresh -> existing on the same browser; new browser with server identity needs confirmation', async () => {
    const be = new FakeBackend();
    const id = ++n;
    const http = be.http('carol');
    const oldStore = `carol-old-${id}`;
    const newStore = `carol-new-${id}`;
    expect(await localDeviceState({ http, username: 'carol', storeName: oldStore })).toBe('fresh');
    const a = await createOlmAdapter({ userId: userIdFor('carol'), deviceId: 'OLD1', transport: createBackendTransport(http), storeName: oldStore, identityGate: memGate() });
    await a.sync();
    const oldIdentity = a.identity();
    expect(await localDeviceState({ http, username: 'carol', storeName: oldStore })).toBe('existing');
    // Probing a store that doesn't exist must not create one.
    expect(await localDeviceState({ http, username: 'carol', storeName: newStore })).toBe('needs-new-device-confirmation');
    expect(await hasLocalKeystore(newStore)).toBe(false);
    // Nothing was published by the probe: server identity is still the old device.
    const pub = fromBundle((await http.request('GET', '/keys/identity/carol')) as never, userIdFor('carol'));
    expect(pub.deviceId).toBe('OLD1');
    // After confirmation the new device publishes; the old browser's local keys are untouched.
    const b = await createOlmAdapter({ userId: userIdFor('carol'), deviceId: 'NEW1', transport: createBackendTransport(http), storeName: newStore, identityGate: memGate() });
    await b.sync();
    expect(fromBundle((await http.request('GET', '/keys/identity/carol')) as never, userIdFor('carol')).deviceId).toBe('NEW1');
    expect(await hasLocalKeystore(oldStore)).toBe(true);
    expect(classifyIdentityChange(oldIdentity, b.identity())).toBe('new-device');
    await a.close(); await b.close();
  });

  it('classifies same-device key swaps as unexpected', () => {
    const base = { userId: '@x:e2ee.local', deviceId: 'D1', ed25519: 'a', curve25519: 'b' };
    expect(classifyIdentityChange(base, { ...base, ed25519: 'z' })).toBe('key-changed');
    expect(classifyIdentityChange(undefined, base)).toBe('key-changed');
  });

  it('server errors other than 404 fail closed', async () => {
    const http = { request: async () => { throw Object.assign(new Error('x'), { status: 500 }); } };
    await expect(localDeviceState({ http, username: 'q', storeName: `none-${++n}` })).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
  });
});
