/**
 * CryptoAdapter backed by matrix-sdk-crypto-wasm (vodozemac Olm), the
 * library recommended in docs/crypto-decision.md. All cryptography
 * (X3DH-style Olm session setup, Double Ratchet, signatures, at-rest store
 * encryption) is performed by the library; this file only wires transport,
 * locking and typed errors.
 */
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
}

export async function createOlmAdapter(opts: OlmAdapterOptions): Promise<CryptoAdapter> {
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
    return M.OlmMachine.initFromStore(new M.UserId(opts.userId), new M.DeviceId(opts.deviceId), handle);
  });
  let closed = false;
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

  return {
    identity: () => ident,

    sync: () =>
      withLock(lockName, async () => {
        guard();
        await flush();
      }),

    encrypt: (peer, plaintext) =>
      withLock(lockName, async () => {
        guard();
        const cached = await machine.getDevice(new M.UserId(peer.userId), new M.DeviceId(peer.deviceId));
        if (!cached) {
          await machine.updateTrackedUsers([new M.UserId(peer.userId)]);
          await flush();
        }
        const claim = await machine.getMissingSessions([new M.UserId(peer.userId)]);
        if (claim) await send(claim.id, M.RequestType.KeysClaim, claim.body);
        const device = await machine.getDevice(new M.UserId(peer.userId), new M.DeviceId(peer.deviceId));
        if (!device) throw new CryptoError('NO_DEVICE', 'Peer device has no published, validly signed bundle');
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
        machine.close();
      }
    },
  };
}
