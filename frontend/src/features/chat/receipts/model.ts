// WhatsApp-style ticks + last seen. Pure logic only (unit-tested); data comes from a ReceiptsAdapter.
import type { MessageStatus } from "../data/types";

export type Tick = "none" | "pending" | "failed" | "sent" | "delivered" | "read";

/** Per-recipient receipt state for one own message (other members only; never includes me). */
export interface RecipientReceipt { userId: string; deliveredAt?: string | null; readAt?: string | null }

/**
 * 1 grey = server accepted, 2 grey = delivered to ALL other recipients, 2 blue = read by ALL.
 * Unknown recipients/empty receipts => stays at single tick (no fake data until backend/crypto land).
 */
export function tickState(status: MessageStatus, recipients: readonly string[], receipts: readonly RecipientReceipt[] | undefined): Tick {
  if (status === "sending") return "pending";
  if (status === "failed") return "failed";
  if (!recipients.length || !receipts?.length) return "sent";
  const by = new Map(receipts.map((r) => [r.userId, r]));
  const all = (f: (r: RecipientReceipt) => boolean) => recipients.every((u) => { const r = by.get(u); return !!r && f(r); });
  if (all((r) => !!r.readAt)) return "read";
  // Reading implies delivery even if the delivered ack arrived later/out of order.
  if (all((r) => !!r.deliveredAt || !!r.readAt)) return "delivered";
  return "sent";
}

/** Last seen from the backend: online flag or timestamp; null/undefined = hidden or unknown (show nothing). */
export type Presence = { online: true } | { online?: false; lastSeenAt: string } | null | undefined;

export const ONLINE_WINDOW_MS = 60_000;

/** "online" | "last seen just now" | "last seen today at 2:10 PM" | "last seen yesterday at …" | "last seen 3/10/2026". */
export function formatLastSeen(p: Presence, now: Date = new Date(), locale?: string): string | null {
  if (!p) return null;
  if (p.online) return "online";
  const t = new Date(p.lastSeenAt);
  if (Number.isNaN(t.getTime())) return null;
  const diff = now.getTime() - t.getTime();
  if (diff < ONLINE_WINDOW_MS) return "last seen just now";
  const time = t.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(t)) / 86_400_000);
  if (days <= 0) return `last seen today at ${time}`;
  if (days === 1) return `last seen yesterday at ${time}`;
  return `last seen ${t.toLocaleDateString(locale)}`;
}

/**
 * Highest-seq read trigger. Debounced; only emits increasing seqs.
 * `allow` gates the actual send (chat open + tab visible). A flush that isn't allowed does not consume the seq,
 * so a later seen()/nudge() still sends it. A rejected send backs off (capped) instead of retrying in a tight loop.
 */
export function readTracker(send: (seq: bigint) => void | false | Promise<void | false>, wait = 500, allow: () => boolean = () => true) {
  let sent = -1n, want = -1n, delay = wait;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight = false;
  const schedule = (ms: number) => {
    if (timer || inflight || !(want > sent)) return;
    timer = setTimeout(flush, ms);
  };
  const after = (ok: boolean, n: bigint) => {
    inflight = false;
    if (ok) { if (n > sent) sent = n; delay = wait; }
    else delay = Math.min(60_000, Math.max(wait, delay * 2));
    if (want > sent && allow()) schedule(ok ? wait : delay);
  };
  function flush() {
    timer = null;
    if (inflight || !(want > sent) || !allow()) return;
    const n = want;
    try {
      const result = send(n);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        inflight = true;
        void Promise.resolve(result as Promise<void | false>).then((v) => after(v !== false, n), () => after(false, n));
        return;
      }
      after(result !== false, n);
    } catch { after(false, n); }
  }
  return {
    seen(seq: string | number | bigint) {
      const n = asBigInt(seq);
      if (n === undefined || n <= sent) return;
      if (n <= want) { schedule(wait); return; } // already pending: keep the timer (or arm one if a hidden flush skipped it)
      want = n;
      if (timer) { clearTimeout(timer); timer = null; } // higher seq restarts the debounce
      schedule(wait);
    },
    /** Try again after the tab becomes visible (never lowers the watermark). */
    nudge() { if (allow()) schedule(delay); },
    cancel() { if (timer) clearTimeout(timer); timer = null; },
  };
}

/** conversationId -> userId -> highest delivered watermark (server deliveredSeq). Monotonic. */
export type DeliveredMarks = Record<string, Record<string, { seq: string; at: string | null }>>;

const DIGITS = /^\d{1,30}$/;

/** Digit string or safe integer → bigint. Never parses through an imprecise Number. */
export function asBigInt(v: string | number | bigint | undefined | null): bigint | undefined {
  if (typeof v === "bigint") return v >= 0n && DIGITS.test(v.toString()) ? v : undefined;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : undefined;
  if (typeof v === "string" && DIGITS.test(v)) return BigInt(v);
  return undefined;
}

/** Canonical decimal form for storage and equality. */
export function seqDigits(v: string | number | bigint | undefined | null): string | undefined {
  const n = asBigInt(v);
  return n === undefined ? undefined : n.toString();
}

/** deliveredSeq only moves forward. A lower or equal watermark (replay, stale response) is ignored. */
export function foldDelivered(marks: DeliveredMarks, incoming: readonly { conversationId: string; userId: string; deliveredSeq: string; deliveredAt?: string | null }[]): DeliveredMarks {
  let out = marks;
  for (const r of incoming) {
    if (!DIGITS.test(r.deliveredSeq)) continue;
    const prev = out[r.conversationId]?.[r.userId];
    if (prev && DIGITS.test(prev.seq) && BigInt(prev.seq) >= BigInt(r.deliveredSeq)) continue;
    const at = r.deliveredAt ?? prev?.at ?? null;
    if (out === marks) out = { ...marks };
    out[r.conversationId] = { ...out[r.conversationId], [r.userId]: { seq: r.deliveredSeq, at } };
  }
  return out;
}

/** Per-message delivered flags from watermarks, then E2EE read marks on top. */
export function receiptsForMessages(
  recipients: readonly string[],
  delivered: DeliveredMarks[string] | undefined,
  reads: ReadMarks[string] | undefined,
  messages: readonly { id: string; seq: string | number | bigint }[],
): Record<string, RecipientReceipt[]> {
  const by: Record<string, RecipientReceipt[]> = {};
  for (const m of messages) {
    const base = recipients.map((userId) => {
      const d = delivered?.[userId];
      const mark = asBigInt(d?.seq);
      const msg = asBigInt(m.seq);
      const has = mark !== undefined && msg !== undefined && mark > 0n && mark >= msg;
      return { userId, deliveredAt: has ? (d?.at || "delivered") : null };
    });
    by[m.id] = mergeReads(base, recipients, reads, m.seq);
  }
  return by;
}

/** Decrypted read receipt from crypto receiveToDevice() (/sync/wait only wakes the client). */
export interface ReadReceipt { conversationId: string; fromUserId: string; upToSeq: string | number | bigint; ts: string | number }
/** conversationId -> fromUserId -> highest read {seq digits, ts}. Compared with BigInt, never as JS numbers. */
export type ReadMarks = Record<string, Record<string, { upToSeq: string; ts: string }>>;

/** upToSeq is monotonic per sender: older/equal values are ignored. Returns the same object if nothing changed. */
export function foldReadReceipts(marks: ReadMarks, incoming: readonly ReadReceipt[]): ReadMarks {
  let out = marks;
  for (const r of incoming) {
    const seq = seqDigits(r.upToSeq);
    if (seq === undefined) continue;
    const prev = out[r.conversationId]?.[r.fromUserId];
    const prevN = asBigInt(prev?.upToSeq);
    const nextN = asBigInt(seq);
    if (prevN !== undefined && nextN !== undefined && prevN >= nextN) continue;
    const ts = typeof r.ts === "number" ? new Date(r.ts).toISOString() : r.ts;
    if (out === marks) out = { ...marks };
    out[r.conversationId] = { ...out[r.conversationId], [r.fromUserId]: { upToSeq: seq, ts } };
  }
  return out;
}

/** Merge server delivered state with E2EE read marks for one own message (by seq). */
export function mergeReads(base: readonly RecipientReceipt[] | undefined, recipients: readonly string[], marks: ReadMarks[string] | undefined, seq: string | number | bigint | undefined): RecipientReceipt[] {
  const by = new Map((base ?? []).map((r) => [r.userId, { ...r }]));
  const msg = asBigInt(seq);
  if (marks && msg !== undefined) for (const u of recipients) {
    const m = marks[u];
    const read = asBigInt(m?.upToSeq);
    if (m && read !== undefined && read >= msg) by.set(u, { ...by.get(u), userId: u, readAt: by.get(u)?.readAt ?? m.ts });
  }
  return [...by.values()];
}
