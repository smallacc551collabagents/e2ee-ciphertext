/**
 * In-memory stand-in for the backend key directory + envelope relay, used only
 * by tests. It implements the server semantics the backend must provide
 * (public bundle storage, query, ATOMIC one-time-prekey claim, envelope queue)
 * and never sees private keys or plaintext.
 */
import type { CiphertextEnvelope, DeviceAddress, KeyServerTransport, ServerRequest } from '../src/contract.js';

type Json = Record<string, unknown>;

export class InMemoryRelay {
  readonly deviceKeys = new Map<string, Map<string, Json>>();
  readonly oneTimeKeys = new Map<string, Array<[string, unknown]>>();
  readonly fallbackKeys = new Map<string, Array<[string, unknown]>>();
  readonly claimed: string[] = [];
  /** Everything the server ever received, for leak assertions. */
  readonly seenBodies: string[] = [];
  private readonly queues = new Map<string, CiphertextEnvelope[]>();

  transport(): KeyServerTransport {
    return { send: async (req, from) => this.handle(req, from) };
  }

  deliver(env: CiphertextEnvelope): void {
    const k = `${env.recipient.userId}|${env.recipient.deviceId}`;
    const q = this.queues.get(k) ?? [];
    q.push(env);
    this.queues.set(k, q);
  }

  drain(to: DeviceAddress): CiphertextEnvelope[] {
    const k = `${to.userId}|${to.deviceId}`;
    const q = this.queues.get(k) ?? [];
    this.queues.delete(k);
    return q;
  }

  private handle(req: ServerRequest, from: DeviceAddress): string {
    this.seenBodies.push(req.body);
    const b = JSON.parse(req.body) as Json;
    const key = `${from.userId}|${from.deviceId}`;
    switch (req.kind) {
      case 'keys.upload': {
        if (b.device_keys) {
          const m = this.deviceKeys.get(from.userId) ?? new Map<string, Json>();
          m.set(from.deviceId, b.device_keys as Json);
          this.deviceKeys.set(from.userId, m);
        }
        const otks = this.oneTimeKeys.get(key) ?? [];
        otks.push(...Object.entries((b.one_time_keys as Json | undefined) ?? {}));
        this.oneTimeKeys.set(key, otks);
        const fb = Object.entries((b.fallback_keys as Json | undefined) ?? {});
        if (fb.length) this.fallbackKeys.set(key, fb);
        return JSON.stringify({ one_time_key_counts: { signed_curve25519: otks.length } });
      }
      case 'keys.query': {
        const out: Json = {};
        for (const u of Object.keys(b.device_keys as Json)) out[u] = Object.fromEntries(this.deviceKeys.get(u) ?? []);
        return JSON.stringify({ device_keys: out, failures: {} });
      }
      case 'keys.claim': {
        const out: Record<string, Json> = {};
        for (const [u, ds] of Object.entries(b.one_time_keys as Record<string, Json>)) {
          for (const d of Object.keys(ds)) {
            const k = `${u}|${d}`;
            // Atomic pop: a one-time prekey is handed out at most once.
            const otk = this.oneTimeKeys.get(k)?.shift() ?? this.fallbackKeys.get(k)?.[0];
            if (!otk) continue;
            this.claimed.push(otk[0]);
            (out[u] ??= {})[d] = Object.fromEntries([otk]);
          }
        }
        return JSON.stringify({ one_time_keys: out, failures: {} });
      }
      default:
        return JSON.stringify({});
    }
  }
}
