/**
 * Realtime "something changed" signal for the chat UI.
 *
 * The UI only needs a doorbell: "conversation X (or something) has news, re-fetch". Today there is no
 * backend push channel, so the default source polls quickly while the tab is visible and fires
 * immediately on focus / visibility / reconnect. When the backend ships its stream (SSE / long-poll /
 * WebSocket doorbell), plug it in via `createRealtime({ stream })`: stream events fire instantly and
 * polling drops to a slow safety-net interval. Nothing here carries message content.
 */
export type RealtimeEvent = { conversationId?: string; reason: "poll" | "focus" | "online" | "stream" };
export type Listener = (e: RealtimeEvent) => void;
/** A pluggable push source. `subscribe` returns an unsubscribe; `onState(false)` means "fall back to fast polling". */
export type RealtimeStream = { subscribe(onEvent: (conversationId?: string) => void, onState: (connected: boolean) => void): () => void };

export const FAST_POLL_MS = 1500;
export const SLOW_POLL_MS = 15000;

export function createRealtime(opts: { stream?: RealtimeStream | null; fastMs?: number; slowMs?: number } = {}) {
  const fastMs = opts.fastMs ?? FAST_POLL_MS;
  const slowMs = opts.slowMs ?? SLOW_POLL_MS;
  const listeners = new Set<Listener>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let streamUp = false;
  let stopStream: (() => void) | null = null;
  const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
  const emit = (e: RealtimeEvent) => { for (const l of [...listeners]) { try { l(e); } catch { /* listener errors never stop the bell */ } } };
  const schedule = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { if (visible()) emit({ reason: "poll" }); }, streamUp ? slowMs : fastMs);
  };
  const onFocus = () => emit({ reason: "focus" });
  const onVis = () => { if (visible()) emit({ reason: "focus" }); };
  const onOnline = () => emit({ reason: "online" });
  function start() {
    schedule();
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVis);
    if (opts.stream) stopStream = opts.stream.subscribe((conversationId) => emit({ reason: "stream", ...(conversationId ? { conversationId } : {}) }), (up) => { streamUp = up; schedule(); });
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVis);
    stopStream?.(); stopStream = null; streamUp = false;
  }
  return {
    /** Subscribe; the source starts with the first listener and stops with the last. */
    subscribe(l: Listener): () => void {
      listeners.add(l);
      if (listeners.size === 1) start();
      return () => { listeners.delete(l); if (listeners.size === 0) stop(); };
    },
    stop() { listeners.clear(); stop(); },
  };
}

type SyncWait = { changed: boolean; cursor: string; conversations: string[]; toDevice: boolean };
const isSyncWait = (x: unknown): x is SyncWait => {
  const o = x as SyncWait | null;
  return !!o && typeof o.changed === "boolean" && typeof o.cursor === "string" && Array.isArray(o.conversations) && typeof o.toDevice === "boolean";
};

/**
 * GET /api/sync/wait (backend #78) long-poll as a RealtimeStream. Read-only doorbell: it never acks.
 * Loops right after each response. Messages we can't decrypt yet stay pending server-side, so the same
 * pending set could come back (the server holds 25s since #80); as a safety net we back off 2s -> 15s, resetting as soon as the set changes.
 * Errors/404 report onState(false) so the bell falls back to fast polling, and retry with backoff
 * (404 = endpoint absent: give up for this page). `guard` throws on logout/account change (#74/#75).
 */
export function createSyncWaitStream(opts: { guard?: () => void; fetchFn?: typeof fetch; timeoutS?: number; minRepeatMs?: number; maxBackoffMs?: number } = {}): RealtimeStream {
  const f = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeoutS = opts.timeoutS ?? 20;
  const minMs = opts.minRepeatMs ?? 2000;
  const maxMs = opts.maxBackoffMs ?? 15000;
  return {
    subscribe(onEvent, onState) {
      const ac = new AbortController();
      let stopped = false;
      const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); ac.signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
      void (async () => {
        let cursor: string | undefined;
        let lastKey = "";
        let repeatMs = 0;
        let errMs = 0;
        let up = false;
        const setUp = (v: boolean) => { if (v !== up) { up = v; onState(v); } };
        while (!stopped) {
          try {
            opts.guard?.();
            const qs = new URLSearchParams({ timeout: String(timeoutS), ...(cursor ? { since: cursor } : {}) });
            const res = await f(`/api/sync/wait?${qs}`, { credentials: "same-origin", cache: "no-store", signal: ac.signal });
            if (res.status === 404) { setUp(false); return; }
            if (!res.ok) throw new Error(`sync/wait ${res.status}`);
            const body: unknown = await res.json();
            if (!isSyncWait(body)) throw new Error("bad sync/wait body");
            errMs = 0;
            setUp(true);
            cursor = body.cursor; // opaque (v2 since #80): always echo the last one as `since`
            // First call (no `since`) returns everything pending at once; treat it like any other wake.
            if (!body.changed) { lastKey = ""; repeatMs = 0; continue; }
            const key = `${[...body.conversations].sort().join(",")}|${body.toDevice}|${body.cursor}`;
            if (key === lastKey) {
              // Same pending set again (e.g. a message waiting for its key): don't spin, back off.
              repeatMs = Math.min(maxMs, repeatMs ? repeatMs * 2 : minMs);
              await sleep(repeatMs);
              continue;
            }
            lastKey = key; repeatMs = 0;
            if (body.conversations.length) body.conversations.forEach((id) => onEvent(id));
            else onEvent();
            // Re-issue immediately: the echoed cursor already covers what we were just told, so the
            // server only wakes us for newer items. No delay after a fresh wake.
          } catch (e) {
            if (stopped || ac.signal.aborted || (e as Error)?.name === "SessionChangedError") { setUp(false); return; }
            setUp(false);
            errMs = Math.min(maxMs, errMs ? errMs * 2 : minMs);
            await sleep(errMs);
          }
        }
      })();
      return () => { stopped = true; ac.abort(); };
    },
  };
}

/** Wrap an async job so overlapping calls never get lost: while it runs, further calls collapse into one re-run. */
export function coalesce(job: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  const run = async (): Promise<void> => {
    if (running) { again = true; return running; }
    running = (async () => { try { do { again = false; await job(); } while (again); } finally { running = null; } })();
    return running;
  };
  return run;
}
