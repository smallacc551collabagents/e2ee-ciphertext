// Live receipts: delivered watermarks + presence from GET /conversations, E2EE read receipts via
// group crypto sendReadReceipt / receiveToDevice().receipts, last-seen privacy, and a visible-tab heartbeat.
// Ticks are monotonic across reload and replay (localStorage + fold). A 404 retires that endpoint; nothing throws to the UI.
import { assertSameAccount, onSessionEnd } from "@/lib/session-guard";
import { conversationListSchema, privacyResponseSchema, type ConversationWire } from "@e2ee/shared";
import { nullReceipts, setReceiptsAdapter, type ConversationReceipts, type ReceiptsAdapter } from "./adapter";
import { asBigInt, foldDelivered, foldReadReceipts, receiptsForMessages, seqDigits, type DeliveredMarks, type ReadMarks, type ReadReceipt } from "./model";

export interface ReceiptsBridge {
  sendReadReceipt(conversationId: string, upToSeq: string | number | bigint, authorUserIds: readonly string[]): Promise<unknown>;
  /** Own messages known locally (id + server seq). Empty until the thread has loaded. */
  ownMessages(conversationId: string): { id: string; seq: string }[];
}

export interface InboundReceipt { conversationId: string; fromUserId: string; upToSeq: string | number; ts: string | number }

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };

const HEARTBEAT_MS = 30_000;
const SEQ = /^\d{1,30}$/;

export function heartbeatDelay(status: number, retryAfter: string | null, prev: number, base = HEARTBEAT_MS): number | "stop" {
  if (status === 404) return "stop";
  if (status === 429) {
    const raw = retryAfter?.trim() ?? "";
    const ra = raw === "" ? NaN : Number(raw);
    const raMs = Number.isFinite(ra) && ra >= 0 ? ra * 1000 : 60_000;
    return Math.max(raMs, base); // never faster than the steady interval
  }
  if (status >= 200 && status < 300) return base;
  return Math.min(60_000, Math.max(base, prev * 2));
}

export function startHeartbeat(opts: {
  fetchFn?: FetchFn;
  visible?: () => boolean;
  baseMs?: number;
  listen?: (fn: () => void) => () => void;
}): () => void {
  const fetchFn = opts.fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const base = opts.baseMs ?? HEARTBEAT_MS;
  const visible = opts.visible ?? (() => typeof document === "undefined" || document.visibilityState === "visible");
  const listen = opts.listen ?? ((fn: () => void) => {
    if (typeof document === "undefined") return () => undefined;
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  });
  let stopped = false;
  let delay = base;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => { if (timer) clearTimeout(timer); timer = null; };
  const arm = (ms: number) => { clear(); if (!stopped) timer = setTimeout(() => void tick(), ms); };
  const tick = async () => {
    if (stopped || !visible()) return;
    let status = 0;
    let retry: string | null = null;
    try {
      assertSameAccount();
      const res = await fetchFn("/api/presence/heartbeat", { method: "POST", credentials: "same-origin", cache: "no-store" });
      status = res.status;
      retry = res.headers.get("retry-after");
    } catch { status = 0; }
    const next = heartbeatDelay(status, retry, delay, base);
    if (next === "stop") { stopped = true; clear(); return; }
    delay = next;
    if (!stopped && visible()) arm(delay);
  };
  const unlisten = listen(() => { if (stopped) return; if (visible()) { delay = base; clear(); void tick(); } else clear(); });
  if (visible()) void tick();
  return () => { stopped = true; clear(); unlisten(); };
}

function safeSeq(seq: string): string | undefined {
  return asBigInt(seq)?.toString();
}

function flatten(marks: ReadMarks): ReadReceipt[] {
  const out: ReadReceipt[] = [];
  for (const [conversationId, by] of Object.entries(marks)) for (const [fromUserId, m] of Object.entries(by)) {
    if (m && asBigInt(m.upToSeq) !== undefined) out.push({ conversationId, fromUserId, upToSeq: m.upToSeq, ts: m.ts });
  }
  return out;
}

function loadState(storage: Store, key: string): { reads: ReadMarks; delivered: DeliveredMarks } {
  try {
    const raw = JSON.parse(storage.getItem(key) ?? "null") as { reads?: ReadMarks; delivered?: DeliveredMarks } | null;
    const reads = raw?.reads && typeof raw.reads === "object" ? raw.reads : {};
    const delivered = raw?.delivered && typeof raw.delivered === "object" ? raw.delivered : {};
    return { reads: foldReadReceipts({}, flatten(reads)), delivered: foldDelivered({}, Object.entries(delivered).flatMap(([conversationId, by]) =>
      Object.entries(by ?? {}).map(([userId, m]) => ({ conversationId, userId, deliveredSeq: m?.seq ?? "", deliveredAt: m?.at ?? null })))) };
  } catch { return { reads: {}, delivered: {} }; }
}

export interface LiveReceipts {
  readonly meId: string;
  readonly adapter: ReceiptsAdapter;
  bind(bridge: ReceiptsBridge | null): void;
  publish(incoming: readonly InboundReceipt[]): void;
  stop(): void;
}

export function createLiveReceipts(opts: {
  me: { id: string; username: string };
  fetchFn?: FetchFn;
  storage?: Store;
  userIdFor?: (username: string) => string;
  heartbeat?: boolean;
  visible?: () => boolean;
  baseMs?: number;
  listen?: (fn: () => void) => () => void;
}): LiveReceipts {
  const fetchFn = opts.fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const storage = opts.storage ?? (typeof localStorage === "undefined" ? { getItem: () => null, setItem: () => undefined } : localStorage);
  const key = `e2ee.receipts.${opts.me.id}`;
  let { reads, delivered } = loadState(storage, key);
  let bridge: ReceiptsBridge | null = null;
  let convosGone = false;
  let privacyGone = false;
  let convCache: ConversationWire[] | null = null;
  const msgCache = new Map<string, { id: string; seq: string }[]>();
  const listeners = new Set<(r: ReadReceipt[]) => void>();
  const persist = () => { try { storage.setItem(key, JSON.stringify({ reads, delivered })); } catch { /* private mode / quota */ } };
  const statusOf = (e: unknown) => { const s = (e as { status?: number })?.status; return typeof s === "number" ? s : undefined; };

  async function libId(username: string): Promise<string> {
    if (opts.userIdFor) return opts.userIdFor(username);
    const { userIdFor } = await import("@e2ee/crypto");
    return userIdFor(username);
  }

  async function listConversations(soft = false): Promise<ConversationWire[] | null> {
    if (convosGone) return convCache;
    try {
      assertSameAccount();
      const res = await fetchFn("/api/conversations", { credentials: "same-origin", cache: "no-store" });
      if (res.status === 404) { convosGone = true; return convCache; }
      if (!res.ok) {
        if (soft) return convCache;
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      }
      const parsed = conversationListSchema.safeParse(await res.json());
      if (!parsed.success) return convCache;
      convCache = parsed.data.conversations;
      return convCache;
    } catch (e) {
      if ((e as { name?: string })?.name === "SessionChangedError") throw e;
      if (statusOf(e) === 404) convosGone = true;
      if (soft || convosGone) return convCache;
      throw e;
    }
  }

  function ownMessages(conversationId: string): { id: string; seq: string }[] {
    const live = bridge?.ownMessages(conversationId) ?? [];
    if (live.length) msgCache.set(conversationId, live);
    const rows = msgCache.get(conversationId) ?? [];
    const out: { id: string; seq: string }[] = [];
    for (const m of rows) { const seq = safeSeq(m.seq); if (seq !== undefined) out.push({ id: m.id, seq }); }
    return out;
  }

  async function project(conversationId: string, own?: readonly { id: string; seq: string }[]): Promise<ConversationReceipts> {
    const list = await listConversations(true);
    const conv = list?.find((c) => c.id === conversationId);
    if (!conv) return { recipients: [], byMessage: {} };
    const others = conv.members.filter((m) => m.id !== opts.me.id);
    const recipients: string[] = [];
    const folded: { conversationId: string; userId: string; deliveredSeq: string; deliveredAt?: string | null }[] = [];
    for (const m of others) {
      const userId = await libId(m.username);
      recipients.push(userId);
      if (m.deliveredSeq && SEQ.test(m.deliveredSeq)) folded.push({ conversationId, userId, deliveredSeq: m.deliveredSeq, deliveredAt: m.deliveredAt ?? null });
    }
    const next = foldDelivered(delivered, folded);
    if (next !== delivered) { delivered = next; persist(); }
    const fromScreen = (own ?? []).flatMap((m) => { const seq = safeSeq(m.seq); return seq ? [{ id: m.id, seq }] : []; });
    if (fromScreen.length) msgCache.set(conversationId, fromScreen);
    const messages = fromScreen.length ? fromScreen : ownMessages(conversationId);
    return { recipients, byMessage: receiptsForMessages(recipients, delivered[conversationId], reads[conversationId], messages) };
  }

  const adapter: ReceiptsAdapter = {
    available: true,
    async sendRead(conversationId, upToSeq) {
      const seq = seqDigits(upToSeq);
      if (!bridge || seq === undefined) throw Object.assign(new Error("receipts not ready"), { status: 503 });
      const list = await listConversations();
      if (convosGone) return; // endpoint retired: stop retrying
      const conv = list?.find((c) => c.id === conversationId);
      if (!conv) return; // not a member anymore
      const authors: string[] = [];
      for (const m of conv.members) if (m.id !== opts.me.id) authors.push(await libId(m.username));
      if (!authors.length) return;
      try { await bridge.sendReadReceipt(conversationId, seq, authors); }
      catch (e) {
        if (statusOf(e) === 404) return; // to-device gone: stop retrying
        throw e;
      }
    },
    receipts: (conversationId, own) => project(conversationId, own),
    onReceipts(cb) {
      const snap = flatten(reads);
      if (snap.length) cb(snap);
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async presence(conversationId) {
      const list = await listConversations(true);
      const conv = list?.find((c) => c.id === conversationId);
      if (!conv) return {};
      const out: Record<string, { online: true } | { online?: false; lastSeenAt: string }> = {};
      for (const m of conv.members) {
        if (m.id === opts.me.id || !m.presence) continue;
        if (m.presence.online) out[m.username] = { online: true };
        else if (m.presence.lastSeenAt) out[m.username] = { lastSeenAt: m.presence.lastSeenAt };
      }
      return out;
    },
    async getLastSeenVisible() {
      if (privacyGone) throw Object.assign(new Error("privacy unavailable"), { status: 404 });
      assertSameAccount();
      const res = await fetchFn("/api/me/privacy", { credentials: "same-origin", cache: "no-store" });
      if (res.status === 404) { privacyGone = true; throw Object.assign(new Error("privacy unavailable"), { status: 404 }); }
      if (!res.ok) throw Object.assign(new Error("privacy"), { status: res.status });
      const parsed = privacyResponseSchema.safeParse(await res.json());
      if (!parsed.success) throw Object.assign(new Error("privacy"), { status: 502 });
      return !parsed.data.hideLastSeen;
    },
    async setLastSeenVisible(visible) {
      if (privacyGone) throw Object.assign(new Error("privacy unavailable"), { status: 404 });
      assertSameAccount();
      const res = await fetchFn("/api/me/privacy", {
        method: "PUT", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hideLastSeen: !visible }),
      });
      if (res.status === 404) { privacyGone = true; throw Object.assign(new Error("privacy unavailable"), { status: 404 }); }
      if (!res.ok) throw Object.assign(new Error("privacy"), { status: res.status });
    },
  };

  const stopHb = opts.heartbeat === false ? () => undefined : startHeartbeat({ fetchFn, visible: opts.visible, baseMs: opts.baseMs, listen: opts.listen });

  return {
    meId: opts.me.id,
    adapter,
    bind(b) { bridge = b; },
    publish(incoming) {
      const mapped: ReadReceipt[] = [];
      for (const r of incoming) {
        const seq = seqDigits(r.upToSeq);
        if (seq === undefined) continue;
        mapped.push({ conversationId: r.conversationId, fromUserId: r.fromUserId, upToSeq: seq, ts: r.ts });
      }
      const next = foldReadReceipts(reads, mapped);
      if (next === reads) return;
      reads = next;
      persist();
      const fresh = mapped.filter((r) => reads[r.conversationId]?.[r.fromUserId]?.upToSeq === r.upToSeq);
      for (const l of listeners) l(fresh);
    },
    stop() { stopHb(); },
  };
}

let current: LiveReceipts | null = null;
let sessionHooked = false;

/** Install (or reuse) the live adapter for this account. Idempotent. No-op during SSR. */
export function installLiveReceipts(me: { id: string; username: string }): void {
  if (typeof window === "undefined" || !me.id) return;
  // Same gate as chatAdapter: fixtures never install the live adapter, and the switch is dead in production.
  if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_CHAT_FIXTURES === "1") return;
  if (!current || current.meId !== me.id) {
    current?.stop();
    current = createLiveReceipts({ me, heartbeat: true });
  }
  setReceiptsAdapter(current.adapter);
  if (!sessionHooked) {
    sessionHooked = true;
    onSessionEnd(() => { current?.stop(); current = null; setReceiptsAdapter(nullReceipts); });
  }
}

export function bindReceiptsBridge(bridge: ReceiptsBridge | null): void { current?.bind(bridge); }

/** Decrypted read receipts from receiveToDevice(). Lower/equal upToSeq per sender are dropped. */
export function publishReceipts(incoming: readonly InboundReceipt[]): void { current?.publish(incoming); }
