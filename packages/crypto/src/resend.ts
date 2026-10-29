/**
 * Sender-side re-send after a recipient replaced its device (E2EE resend, Signal-style).
 *
 * When B confirms "Use this browser", messages A had queued to B's OLD device were
 * encrypted to a session the new device can never open. The backend flags them
 * `undeliverable_device_changed`, never delivers that ciphertext to the new device,
 * and lists them to the SENDER. The sender's client re-encrypts the plaintext from its
 * own encrypted history store to the new (accepted) identity and re-sends it with the
 * SAME clientMsgId; the server replaces the stale ciphertext in place (same id + seq),
 * so the recipient sees them once, in the original order.
 *
 * Never re-sends before the user accepted the new safety number: resendPending()
 * goes through the caller's encrypt path, whose identity gate refuses unaccepted changes.
 *
 * Backend contract (PR #50; @e2ee/shared undeliverableListSchema; 404 => nothing pending, list capped at 500):
 *   GET /conversations/:id/undeliverable
 *   200 { "undeliverable": [ { "messageId": string, "clientMsgId": string, "seq": "<digits>",
 *         "recipientId": string, "reason": "undeliverable_device_changed" } ] }
 *   Only messages SENT BY the caller are listed. Re-send = the normal
 *   POST /conversations/:id/messages with the same clientMsgId; for a flagged message the
 *   server replaces ciphertext/version, clears the flag, keeps id + seq and returns
 *   { message, duplicate: false }. For an unflagged one it returns duplicate: true (idempotent).
 */
import type { CiphertextEnvelope, DeviceIdentity } from './contract.js';
import type { BackendHttp } from './backend-bridge.js';
import type { HistoryEntry, HistoryStore } from './history-store.js';

/** Mirrors @e2ee/shared UNDELIVERABLE_DEVICE_CHANGED (parity asserted in test/resend.test.ts; crypto has no runtime dep on shared). */
export const UNDELIVERABLE_DEVICE_CHANGED = 'undeliverable_device_changed' as const;
/** Receiver-side text for old-device ciphertext that still arrives. */
export const PREVIOUS_DEVICE_TEXT = 'This message was sent to your previous device';
/** Sender-side status text for a flagged message awaiting re-send. */
export const NOT_DELIVERED_TEXT = 'Not delivered: recipient changed device';

export interface UndeliverableItem {
  readonly messageId: string;
  readonly clientMsgId: string;
  readonly seq: string;
  readonly recipientId?: string;
  readonly reason: typeof UNDELIVERABLE_DEVICE_CHANGED;
}

const CMID = /^[A-Za-z0-9_-]{8,64}$/;

/** GET /conversations/:id/undeliverable. Malformed items are dropped; 404 => []. */
/** Optional strict parser (the app passes @e2ee/shared undeliverableListSchema.parse). */
export type UndeliverableParser = (raw: unknown) => { undeliverable: readonly unknown[] };

export async function fetchUndeliverable(http: BackendHttp, conversationId: string, parse?: UndeliverableParser): Promise<UndeliverableItem[]> {
  let raw: unknown;
  try {
    raw = await http.request('GET', `/conversations/${encodeURIComponent(conversationId)}/undeliverable`);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return [];
    throw e;
  }
  const list = parse ? parse(raw).undeliverable : (raw as { undeliverable?: unknown })?.undeliverable;
  if (!Array.isArray(list)) return [];
  return list.filter((x): x is UndeliverableItem => !!x && typeof x === 'object'
    && typeof x.messageId === 'string' && typeof x.clientMsgId === 'string' && CMID.test(x.clientMsgId)
    && typeof x.seq === 'string' && /^\d{1,20}$/.test(x.seq) && x.reason === UNDELIVERABLE_DEVICE_CHANGED);
}

export interface PendingResend { readonly clientMsgId: string; readonly messageId: string; readonly seq: string; readonly text: string | null }

export interface ResendOptions {
  http: BackendHttp;
  history: Pick<HistoryStore, 'list'>;
  /** This user's library user id; only own messages are re-sent. */
  selfUserId: string;
  /** Encrypt `text` for the conversation peer (identity-gated) and POST it with `clientMsgId`. */
  send(conversationId: string, text: string, clientMsgId: string): Promise<void>;
  parse?: UndeliverableParser;
}

export interface ResendResult { readonly resent: string[]; readonly missing: string[]; readonly failed: string[] }

export function createResender(o: ResendOptions) {
  const inflight = new Map<string, Promise<ResendResult>>();
  async function pendingResends(conversationId: string): Promise<PendingResend[]> {
    const items = await fetchUndeliverable(o.http, conversationId, o.parse);
    if (!items.length) return [];
    const local = await o.history.list(conversationId, undefined, 100_000);
    const byCmid = new Map<string, HistoryEntry>();
    for (const e of local) if (e.clientMsgId && e.senderUserId === o.selfUserId) byCmid.set(e.clientMsgId, e);
    const seen = new Set<string>();
    return items
      .filter((i) => !seen.has(i.clientMsgId) && seen.add(i.clientMsgId))
      .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0))
      .map((i) => ({ clientMsgId: i.clientMsgId, messageId: i.messageId, seq: i.seq, text: byCmid.get(i.clientMsgId)?.text ?? null }));
  }
  /** Re-send flagged messages in seq order; serialised per conversation. Stops at the first failure to keep order. */
  function resendPending(conversationId: string): Promise<ResendResult> {
    const prev = inflight.get(conversationId) ?? Promise.resolve({ resent: [], missing: [], failed: [] });
    const run = prev.catch(() => undefined).then(async () => {
      const resent: string[] = []; const missing: string[] = []; const failed: string[] = [];
      const list = await pendingResends(conversationId);
      for (let i = 0; i < list.length; i++) {
        const p = list[i]!;
        if (p.text === null) { missing.push(p.clientMsgId); continue; } // plaintext not on this device
        try { await o.send(conversationId, p.text, p.clientMsgId); resent.push(p.clientMsgId); } catch (e) {
          failed.push(...list.slice(i).filter((x) => x.text !== null).map((x) => x.clientMsgId));
          void e; // IDENTITY_CHANGED (not accepted yet) or transport: keep order, retry later
          break;
        }
      }
      return { resent, missing, failed };
    });
    inflight.set(conversationId, run);
    return run;
  }
  return { pendingResends, resendPending };
}

/**
 * True when a failed envelope was addressed to a different device (or different keys) of
 * this user than `self`: i.e. old-device ciphertext. Show PREVIOUS_DEVICE_TEXT for it.
 */
export function isForPreviousDevice(env: CiphertextEnvelope | undefined, self: Pick<DeviceIdentity, 'userId' | 'deviceId' | 'curve25519'>): boolean {
  if (!env?.recipient || env.recipient.userId !== self.userId) return false;
  if (env.recipient.deviceId !== self.deviceId) return true;
  const ct = (env.content as { ciphertext?: unknown })?.ciphertext;
  return !!ct && typeof ct === 'object' && !(self.curve25519 in (ct as object));
}
