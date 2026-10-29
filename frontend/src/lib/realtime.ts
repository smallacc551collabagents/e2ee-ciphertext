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
