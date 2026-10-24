/* eslint-disable @typescript-eslint/no-explicit-any -- raw IndexedDB rows in tamper tests */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { InMemoryRelay } from './relay.js';
import { createIdentityGate, createOlmAdapter, deleteLocalCryptoState, historyDbName, openHistoryStore, type HistoryMessage } from '../src/index.js';

let n = 0;
const msg = (i: number, text = `hello ${i}`): HistoryMessage => ({ id: `m${i}`, senderUserId: '@alice:e2ee.test', senderDeviceId: 'ALICE1', text, sentAt: '2026-10-24T04:00:00.000Z' });

async function rawRows(name: string): Promise<any[]> {
  const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(historyDbName(name)); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const rows = await new Promise<any[]>((res) => { const r = db.transaction('messages').objectStore('messages').getAll(); r.onsuccess = () => res(r.result); });
  db.close();
  return rows;
}
async function writeRow(name: string, row: any) {
  const db = await new Promise<IDBDatabase>((res) => { const r = indexedDB.open(historyDbName(name)); r.onsuccess = () => res(r.result); });
  await new Promise<void>((res) => { const tx = db.transaction('messages', 'readwrite'); tx.objectStore('messages').put(row); tx.oncomplete = () => res(); });
  db.close();
}

describe('historyStore (encrypted message history at rest)', () => {
  it('round-trips, orders by numeric seq, filters by afterSeq, tracks lastSeq per conversation', async () => {
    const name = `h-${++n}`;
    const h = await openHistoryStore(name);
    for (const s of [10, 2, 1, 100]) await h.put('c1', String(s), msg(s));
    await h.put('c2', 5n, msg(5, 'other convo'));
    expect((await h.list('c1')).map((e) => e.seq)).toEqual(['1', '2', '10', '100']);
    expect((await h.list('c1', '2')).map((e) => e.text)).toEqual(['hello 10', 'hello 100']);
    expect(await h.lastSeq('c1')).toBe('100');
    expect(await h.lastSeq('c2')).toBe('5');
    expect(await h.lastSeq('nope')).toBeNull();
    expect((await h.list('c2'))[0]).toMatchObject({ conversationId: 'c2', seq: '5', text: 'other convo', senderDeviceId: 'ALICE1' });
    await h.clear();
    expect(await h.list('c1')).toEqual([]);
    h.close();
  });

  it('stores no plaintext at rest', async () => {
    const name = `h-${++n}`;
    const h = await openHistoryStore(name);
    await h.put('c1', '1', msg(1, 'top secret plaintext'));
    h.close();
    const rows = await rawRows(name);
    expect(rows).toHaveLength(1);
    const dump = JSON.stringify(rows, (_k, v) => (v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? Buffer.from(v as ArrayBuffer).toString('latin1') : v));
    expect(dump).not.toContain('top secret');
    expect(Object.keys(rows[0]).sort()).toEqual(['conversationId', 'ct', 'iv', 'seq']);
  });

  it('rejects tampered ciphertext and records moved to another seq or conversation (AAD)', async () => {
    const name = `h-${++n}`;
    let h = await openHistoryStore(name);
    await h.put('c1', '1', msg(1));
    await h.put('c1', '2', msg(2));
    h.close();
    const [r1] = await rawRows(name);
    const flipped = new Uint8Array(r1.ct.slice(0)); flipped[0]! ^= 1;
    await writeRow(name, { ...r1, ct: flipped.buffer });
    h = await openHistoryStore(name);
    await expect(h.list('c1')).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
    await h.put('c1', '1', msg(1)); // repair
    h.close();
    const [good] = await rawRows(name);
    await writeRow(name, { ...good, seq: '00000000000000000099' }); // replay into another slot
    h = await openHistoryStore(name);
    await expect(h.list('c1', '2')).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
    h.close();
    await writeRow(name, { ...good, conversationId: 'c2' }); // move to another conversation
    h = await openHistoryStore(name);
    await expect(h.list('c2')).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
    h.close();
  });

  it('survives reload; deleteLocalCryptoState wipes it with the other stores', async () => {
    const name = `h-${++n}`;
    let h = await openHistoryStore(name);
    await h.put('c1', '7', msg(7, 'persisted'));
    h.close();
    await expect(h.list('c1')).rejects.toMatchObject({ code: 'NOT_INITIALIZED' });
    h = await openHistoryStore(name);
    expect(await h.list('c1')).toMatchObject([{ seq: '7', text: 'persisted' }]);
    h.close();
    await deleteLocalCryptoState(name);
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).not.toContain(historyDbName(name));
    h = await openHistoryStore(name); // fresh key, empty
    expect(await h.list('c1')).toEqual([]);
    h.close();
  });

  it('rejects invalid seq values', async () => {
    const h = await openHistoryStore(`h-${++n}`);
    await expect(h.put('c1', '-1', msg(1))).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });
    await expect(h.put('c1', '1e3', msg(1))).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });
    h.close();
  });

  it('logout wipe removes the Olm store, its wrapping key and history together', async () => {
    const name = `wipe-${++n}`;
    const gate = createIdentityGate({ get: async () => undefined, set: async () => {} });
    const a = await createOlmAdapter({ userId: '@w:e2ee.test', deviceId: 'W1', transport: new InMemoryRelay().transport(), storeName: name, identityGate: gate });
    const h = await openHistoryStore(name);
    a.close(); h.close();
    const mine = async () => (await indexedDB.databases()).map((d) => d.name).filter((x) => x?.startsWith(name));
    expect((await mine()).length).toBe(4);
    await deleteLocalCryptoState(name);
    expect(await mine()).toEqual([]);
  });
});
