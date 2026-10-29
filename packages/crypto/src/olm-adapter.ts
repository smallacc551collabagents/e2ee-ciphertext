/**
 * CryptoAdapter backed by matrix-sdk-crypto-wasm (vodozemac Olm), the
 * library recommended in docs/crypto-decision.md. All cryptography
 * (X3DH-style Olm session setup, Double Ratchet, signatures, at-rest store
 * encryption) is performed by the library; this file only wires transport,
 * locking and typed errors.
 */
import { trackOpen } from './session.js';
import * as M from '@matrix-org/matrix-sdk-crypto-wasm';
import {
  CryptoError,
  type CiphertextEnvelope,
  type CryptoAdapter,
  type DeviceAddress,
  type DeviceIdentity,
  type KeyServerTransport,
  type ReceiveResult,
  type ServerRequestKind,
} from './contract.js';
import { withLock } from './lock.js';
import { getOrCreateStoreKey } from './store-key.js';
import type { IdentityGate } from './peer-trust.js';
import type { GroupPrimitives, GroupDecryptResult, GroupShareResult, ToDeviceResult } from './groups.js';

const ALG = 'm.olm.v1.curve25519-aes-sha2' as const;
const MESSAGE_TYPE = 'org.e2ee.message.v1';

let wasmReady: Promise<void> | undefined;
function initWasm(): Promise<void> {
  wasmReady ??= M.initAsync();
  return wasmReady;
}

function kindOf(t: M.RequestType): ServerRequestKind {
  switch (t) {
    case M.RequestType.KeysUpload:
      return 'keys.upload';
    case M.RequestType.KeysQuery:
      return 'keys.query';
    case M.RequestType.KeysClaim:
      return 'keys.claim';
    case M.RequestType.ToDevice:
      return 'envelopes.send';
    default:
      return 'other';
  }
}

export interface OlmAdapterOptions {
  readonly userId: string;
  readonly deviceId: string;
  readonly transport: KeyServerTransport;
  /** IndexedDB database name prefix for this device's encrypted store. */
  readonly storeName: string;
  /**
   * Required: blocks encrypt() to unverified identity changes (see createIdentityGate).
   * Enforced at runtime too, so untyped callers can't silently opt out.
   */
  readonly identityGate: IdentityGate;
}

export type OlmAdapter = CryptoAdapter & GroupPrimitives;

export async function createOlmAdapter(opts: OlmAdapterOptions): Promise<OlmAdapter> {
  const gate = (opts as Partial<OlmAdapterOptions> | undefined)?.identityGate;
  if (!gate || typeof gate.assertTrusted !== 'function' || typeof gate.assertUserNotPending !== 'function') {
    throw new CryptoError('INVALID_OPTIONS', 'createOlmAdapter requires an identityGate (see createIdentityGate)');
  }
  await initWasm();
  const self: DeviceAddress = { userId: opts.userId, deviceId: opts.deviceId };
  const lockName = `e2ee-crypto:${opts.storeName}`;
  const machine = await withLock(lockName, async () => {
    const storeKey = await getOrCreateStoreKey(`${opts.storeName}-wrap`);
    let handle: M.StoreHandle;
    try {
      handle = await M.StoreHandle.openWithKey(opts.storeName, storeKey);
    } catch (e) {
      throw new CryptoError('STORAGE_FAILED', 'Could not open the encrypted crypto store', { cause: e });
    } finally {
      storeKey.fill(0);
    }
    try {
      return await M.OlmMachine.initFromStore(new M.UserId(opts.userId), new M.DeviceId(opts.deviceId), handle);
    } finally {
      // The machine holds its own reference to the store; free ours so close() releases the IndexedDB connection.
      handle.free();
    }
  });
  let closed = false;
  let api: { close(): void } | null = null;
  const untrack = trackOpen(opts.storeName, () => api?.close());
  // Signal an empty fallback-key set once so the library creates a signed
  // fallback key: the backend requires it as the signed prekey on first publish.
  await withLock(lockName, () => machine.receiveSyncChanges('[]', new M.DeviceLists(), new Map(), new Set()));

  const keys = machine.identityKeys;
  const ident: DeviceIdentity = {
    ...self,
    ed25519: keys.ed25519.toBase64(),
    curve25519: keys.curve25519.toBase64(),
  };

  const guard = () => {
    if (closed) throw new CryptoError('NOT_INITIALIZED', 'Adapter is closed');
  };

  async function send(id: string, type: M.RequestType, body: string, eventType?: string): Promise<void> {
    let response: string;
    try {
      response = await opts.transport.send(
        eventType === undefined ? { kind: kindOf(type), body } : { kind: kindOf(type), body, eventType },
        self,
      );
    } catch (e) {
      throw new CryptoError('TRANSPORT_FAILED', 'Key server request failed', { cause: e });
    }
    await machine.markRequestAsSent(id, type, response);
  }

  async function flush(): Promise<void> {
    for (const r of await machine.outgoingRequests()) {
      const req = r as { id: string; type: M.RequestType; body: string; event_type?: string };
      await send(req.id, req.type, req.body, req.event_type);
    }
  }

  const MEGOLM = 'm.megolm.v1.aes-sha2';
  const GROUP_EVENT = 'org.e2ee.group.message.v1';
  const WEEK_US = 7n * 24n * 60n * 60n * 1000n * 1000n;

  const roomOf = (groupId: string): string => {
    if (!/^[A-Za-z0-9._~-]{1,128}$/.test(groupId)) throw new CryptoError('INVALID_OPTIONS', 'Invalid group id');
    return `!${groupId}:e2ee.local`;
  };

  const group: GroupPrimitives = {
    shareGroupKey: (groupId, userIds, o) =>
      withLock(lockName, async () => {
        guard();
        const room = new M.RoomId(roomOf(groupId));
        if (o.rotate) await machine.invalidateGroupSession(room);
        const others = [...new Set(userIds)].filter((u) => u !== self.userId);
        // Re-query so a replaced device is dropped and only the CURRENT published device is known.
        if (others.length) {
          const ids = () => others.map((u) => new M.UserId(u));
          await machine.updateTrackedUsers(ids());
          await machine.receiveSyncChanges('[]', new M.DeviceLists(ids()), new Map());
          await flush();
        }
        const trusted: string[] = [];
        const pending: string[] = [];
        for (const u of others) {
          try {
            await gate.assertUserNotPending(u);
            const devs = (await machine.getUserDevices(new M.UserId(u))).devices();
            if (!devs.length) throw new CryptoError('NO_DEVICE', 'No published device');
            for (const d of devs) {
              await gate.assertTrusted({
                userId: u,
                deviceId: d.deviceId.toString(),
                ed25519: d.ed25519Key?.toBase64() ?? '',
                curve25519: d.curve25519Key?.toBase64() ?? '',
              });
            }
            trusted.push(u);
          } catch (e) {
            if (e instanceof CryptoError && (e.code === 'IDENTITY_CHANGED' || e.code === 'NO_DEVICE')) pending.push(u);
            else throw e;
          }
        }
        const users = () => [self.userId, ...trusted].map((u) => new M.UserId(u));
        const claim = await machine.getMissingSessions(users());
        if (claim) await send(claim.id, M.RequestType.KeysClaim, claim.body);
        const settings = new M.EncryptionSettings();
        settings.rotationPeriodMessages = BigInt(o.rotationMessages ?? 100);
        settings.rotationPeriod = o.rotationUs ?? WEEK_US;
        settings.historyVisibility = M.HistoryVisibility.Joined;
        settings.sharingStrategy = M.CollectStrategy.deviceBasedStrategy(false, false);
        const reqs = await machine.shareRoomKey(room, users(), settings);
        const envelopes: CiphertextEnvelope[] = [];
        for (const r of reqs) {
          const body = JSON.parse(r.body) as { messages: Record<string, Record<string, Record<string, unknown>>> };
          for (const [userId, devs] of Object.entries(body.messages)) {
            for (const [deviceId, content] of Object.entries(devs)) {
              if (userId === self.userId && deviceId === self.deviceId) continue;
              envelopes.push({ v: 1, alg: ALG, sender: self, recipient: { userId, deviceId }, content });
            }
          }
          // The caller delivers the envelopes; on delivery failure it must call shareGroupKey({rotate:true}).
          await machine.markRequestAsSent(r.id, r.type, '{}');
        }
        return { envelopes, pending, trusted } satisfies GroupShareResult;
      }),

    encryptGroup: (groupId, plaintext) =>
      withLock(lockName, async () => {
        guard();
        const c = await machine.encryptRoomEvent(new M.RoomId(roomOf(groupId)), GROUP_EVENT, JSON.stringify({ body: plaintext }));
        return JSON.parse(c) as Record<string, unknown>;
      }),

    decryptGroup: (groupId, ev) =>
      withLock(lockName, async (): Promise<GroupDecryptResult> => {
        guard();
        const sessionId = String((ev.content as { session_id?: unknown }).session_id ?? '');
        if ((ev.content as { algorithm?: unknown }).algorithm !== MEGOLM) {
          return { ok: false, code: 'INVALID_ENVELOPE', sessionId };
        }
        const event = {
          type: 'm.room.encrypted', event_id: `$${ev.eventId}`, sender: ev.sender.userId,
          origin_server_ts: ev.ts, room_id: roomOf(groupId), content: ev.content,
        };
        try {
          const d = await machine.decryptRoomEvent(JSON.stringify(event), new M.RoomId(roomOf(groupId)), new M.DecryptionSettings(M.TrustRequirement.Untrusted));
          const raw = JSON.parse(d.event) as { type?: string; room_id?: string; content?: { body?: unknown } };
          let deviceOk = d.senderDevice?.toString() === ev.sender.deviceId;
          if (!d.senderDevice) {
            // Session imported via a key response: bind it to the claimed device by its curve25519 key.
            const dev = await machine.getDevice(new M.UserId(ev.sender.userId), new M.DeviceId(ev.sender.deviceId));
            deviceOk = !!dev && dev.curve25519Key?.toBase64() === d.senderCurve25519Key;
          }
          if (!deviceOk || d.sender.toString() !== ev.sender.userId) {
            return { ok: false, code: 'IDENTITY_CHANGED', sessionId };
          }
          if (raw.type !== GROUP_EVENT || raw.room_id !== roomOf(groupId) || typeof raw.content?.body !== 'string') {
            return { ok: false, code: 'DECRYPT_FAILED', sessionId };
          }
          return { ok: true, plaintext: raw.content.body, senderCurve25519: d.senderCurve25519Key, sessionId };
        } catch (e) {
          const code = (e as { code?: unknown }).code;
          if (code === M.DecryptionErrorCode.MissingRoomKey || code === M.DecryptionErrorCode.UnknownMessageIndex) {
            return { ok: false, code: 'MISSING_ROOM_KEY', sessionId };
          }
          return { ok: false, code: 'DECRYPT_FAILED', sessionId };
        }
      }),

    exportGroupSession: (groupId, sessionId) =>
      withLock(lockName, async () => {
        guard();
        const json = await machine.exportRoomKeys(
          (s) => s.roomId.toString() === roomOf(groupId) && s.sessionId === sessionId && s.senderKey.toBase64() === ident.curve25519,
        );
        const arr = JSON.parse(json) as unknown[];
        return arr.length ? json : null;
      }),

    importGroupSession: (groupId, sessionId, senderCurve25519, json) =>
      withLock(lockName, async () => {
        guard();
        let arr: { room_id?: string; session_id?: string; sender_key?: string }[];
        try { arr = JSON.parse(json); } catch { return false; }
        // Only accept exactly the requested session, created by the device that answered.
        if (!Array.isArray(arr) || arr.length !== 1) return false;
        const k = arr[0]!;
        if (k.room_id !== roomOf(groupId) || k.session_id !== sessionId || k.sender_key !== senderCurve25519) return false;
        const r = await machine.importExportedRoomKeys(json, () => {});
        return r.importedCount > 0 || r.totalCount > 0;
      }),

    receiveToDevice: (envelopes) =>
      withLock(lockName, async () => {
        guard();
        const out: ToDeviceResult[] = [];
        for (const env of envelopes) {
          if (env.v !== 1 || env.alg !== ALG || env.recipient.userId !== self.userId || env.recipient.deviceId !== self.deviceId) {
            out.push({ envelope: env, kind: 'invalid' });
            continue;
          }
          const known = await machine.getDevice(new M.UserId(env.sender.userId), new M.DeviceId(env.sender.deviceId));
          if (!known) {
            await machine.updateTrackedUsers([new M.UserId(env.sender.userId)]);
            await machine.receiveSyncChanges('[]', new M.DeviceLists([new M.UserId(env.sender.userId)]), new Map());
            await flush();
          }
          const event = { type: 'm.room.encrypted', sender: env.sender.userId, content: env.content };
          const r = (await machine.receiveSyncChanges(JSON.stringify([event]), new M.DeviceLists(), new Map()))[0];
          let res: ToDeviceResult = { envelope: env, kind: 'invalid' };
          if (r && r.type === M.ProcessedToDeviceEventType.Decrypted) {
            const d = r as M.DecryptedToDeviceEvent;
            const raw = JSON.parse(d.rawEvent) as { type?: string; sender?: string; content?: { body?: unknown } };
            if (d.encryptionInfo.senderDevice?.toString() === env.sender.deviceId && raw.sender === env.sender.userId) {
              if (raw.type === 'm.room_key') res = { envelope: env, kind: 'room_key' };
              else if (raw.type === MESSAGE_TYPE && typeof raw.content?.body === 'string') {
                res = { envelope: env, kind: 'message', plaintext: raw.content.body, senderCurve25519: d.encryptionInfo.senderCurve25519Key };
              }
            }
          }
          out.push(res);
        }
        return out;
      }),
  };

  const adapter: OlmAdapter = {
    ...group,
    identity: () => ident,

    sync: () =>
      withLock(lockName, async () => {
        guard();
        await flush();
      }),

    encrypt: (peer, plaintext) =>
      withLock(lockName, async () => {
        guard();
        // A pending identity change blocks every device of that user, before any lookup.
        await gate.assertUserNotPending(peer.userId);
        const cached = await machine.getDevice(new M.UserId(peer.userId), new M.DeviceId(peer.deviceId));
        if (!cached) {
          // Unknown device: mark the user dirty so a tracked user is re-queried too.
          await machine.updateTrackedUsers([new M.UserId(peer.userId)]);
          await machine.receiveSyncChanges('[]', new M.DeviceLists([new M.UserId(peer.userId)]), new Map());
          await flush();
        }
        const device = await machine.getDevice(new M.UserId(peer.userId), new M.DeviceId(peer.deviceId));
        if (!device) throw new CryptoError('NO_DEVICE', 'Peer device has no published, validly signed bundle');
        // Gate before claiming, so a blocked peer never costs a one-time prekey.
        {
          await gate.assertTrusted({
            userId: peer.userId,
            deviceId: peer.deviceId,
            ed25519: device.ed25519Key?.toBase64() ?? '',
            curve25519: device.curve25519Key?.toBase64() ?? '',
          });
        }
        const claim = await machine.getMissingSessions([new M.UserId(peer.userId)]);
        if (claim) await send(claim.id, M.RequestType.KeysClaim, claim.body);
        let content: string;
        try {
          content = await device.encryptToDeviceEvent(MESSAGE_TYPE, { body: plaintext });
        } catch (e) {
          throw new CryptoError('NO_SESSION', 'Could not establish an Olm session with the peer device', { cause: e });
        }
        return {
          v: 1,
          alg: ALG,
          sender: self,
          recipient: { userId: peer.userId, deviceId: peer.deviceId },
          content: JSON.parse(content) as Record<string, unknown>,
        } satisfies CiphertextEnvelope;
      }),

    receive: (envelopes) =>
      withLock(lockName, async () => {
        guard();
        const results: ReceiveResult[] = [];
        // One envelope per call so each result maps unambiguously to its input.
        for (const env of envelopes) {
          if (
            env.v !== 1 ||
            env.alg !== ALG ||
            env.recipient.userId !== self.userId ||
            env.recipient.deviceId !== self.deviceId ||
            (env.content as { algorithm?: unknown }).algorithm !== ALG
          ) {
            results.push({ ok: false, envelope: env, error: new CryptoError('INVALID_ENVELOPE', 'Unsupported or misaddressed envelope') });
            continue;
          }
          // Know the sender's published devices first, so the library can bind
          // the authenticated Curve25519 key to a specific signed device.
          // Device keys are cached (verified) in the encrypted store; only query
          // when the sender device is unknown. Never claims OTKs on receive.
          const known = await machine.getDevice(new M.UserId(env.sender.userId), new M.DeviceId(env.sender.deviceId));
          if (!known) {
            await machine.updateTrackedUsers([new M.UserId(env.sender.userId)]);
            await machine.receiveSyncChanges('[]', new M.DeviceLists([new M.UserId(env.sender.userId)]), new Map());
            await flush();
          }
          const event = { type: 'm.room.encrypted', sender: env.sender.userId, content: env.content };
          const out = await machine.receiveSyncChanges(JSON.stringify([event]), new M.DeviceLists(), new Map());
          const r = out[0];
          if (r && r.type === M.ProcessedToDeviceEventType.Decrypted) {
            const d = r as M.DecryptedToDeviceEvent;
            const raw = JSON.parse(d.rawEvent) as { type?: string; sender?: string; content?: { body?: unknown } };
            const senderDevice = d.encryptionInfo.senderDevice?.toString();
            if (senderDevice !== env.sender.deviceId) {
              results.push({
                ok: false,
                envelope: env,
                error: new CryptoError('IDENTITY_CHANGED', 'Sender key does not match the claimed sender device'),
              });
              continue;
            }
            if (raw.type === MESSAGE_TYPE && raw.sender === env.sender.userId && typeof raw.content?.body === 'string') {
              results.push({
                ok: true,
                sender: env.sender,
                senderCurve25519: d.encryptionInfo.senderCurve25519Key,
                plaintext: raw.content.body,
              });
              continue;
            }
          }
          results.push({
            ok: false,
            envelope: env,
            error: new CryptoError('DECRYPT_FAILED', 'Message failed authentication or could not be decrypted'),
          });
        }
        return results;
      }),

    replenishPrekeys: (serverCount) =>
      withLock(lockName, async () => {
        guard();
        await machine.receiveSyncChanges('[]', new M.DeviceLists(), new Map([['signed_curve25519', serverCount]]), new Set(['signed_curve25519']));
        await flush();
      }),

    refreshPeer: (userId) =>
      withLock(lockName, async () => {
        guard();
        await machine.updateTrackedUsers([new M.UserId(userId)]);
        await machine.receiveSyncChanges('[]', new M.DeviceLists([new M.UserId(userId)]), new Map());
        await flush();
        const devices = await machine.getUserDevices(new M.UserId(userId));
        return devices.devices().map((d) => ({
          userId,
          deviceId: d.deviceId.toString(),
          ed25519: d.ed25519Key?.toBase64() ?? '',
          curve25519: d.curve25519Key?.toBase64() ?? '',
        }));
      }),

    peerIdentities: async (userId) => {
      guard();
      const devices = await machine.getUserDevices(new M.UserId(userId));
      return devices.devices().map((d) => ({
        userId,
        deviceId: d.deviceId.toString(),
        ed25519: d.ed25519Key?.toBase64() ?? '',
        curve25519: d.curve25519Key?.toBase64() ?? '',
      }));
    },

    close: () => {
      if (!closed) {
        closed = true;
        untrack();
        machine.close();
      }
    },
  };
  api = adapter;
  return adapter;
}
