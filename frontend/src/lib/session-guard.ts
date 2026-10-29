/**
 * One browser = one session cookie, shared by every tab. A tab that was opened as user X keeps X's
 * in-memory session (keys, adapter, polling) after another tab logs out and signs in as Y, and its
 * requests would then carry Y's cookie: X's typed messages get sent as Y (P0, E2EE). Every tab records
 * which account it is bound to; all /api calls from the chat check it and refuse + hard-reload on mismatch.
 */
const KEY = "e2ee.activeUser";
let bound: string | null = null;
let ended = false; // after logout/reset: every /api call from this JS context is refused until the page is gone
const teardown = new Set<() => void>();
/** Register a stopper (poll interval, resender, adapter context); run by endSession() before stores close. */
export function onSessionEnd(fn: () => void): () => void { teardown.add(fn); return () => teardown.delete(fn); }
/** Stop timers, polling, resends and drop adapter contexts. Call BEFORE closeLocalE2EE(). */
export function endSession(): void {
  ended = true;
  for (const fn of [...teardown]) { try { fn(); } catch { /* ignore */ } }
  teardown.clear();
}

export class SessionChangedError extends Error {
  constructor() { super("Signed-in account changed in another tab"); this.name = "SessionChangedError"; }
}
const current = () => { try { return localStorage.getItem(KEY); } catch { return null; } };

/** The account whose cookie is now set (call after sign-in, before any navigation). "" = signed out. */
export function setActiveUser(userId: string): void { try { localStorage.setItem(KEY, userId); } catch { /* storage off */ } }

/** Bind this tab to `userId` (server-verified on page render). Reloads the tab if another tab switches account. */
export function bindTab(userId: string): () => void {
  ended = false;
  bound = userId;
  setActiveUser(userId);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY && e.newValue !== userId) hardReset(); };
  window.addEventListener("storage", onStorage);
  return () => { window.removeEventListener("storage", onStorage); if (bound === userId) bound = null; };
}

/** Throw (and reset the tab) if this tab's account is no longer the browser's signed-in account. */
export function assertSameAccount(): void {
  if (ended) throw new SessionChangedError();
  if (bound === null) return;
  if (current() !== bound) { hardReset(); throw new SessionChangedError(); }
}

/** Drop all in-memory state (adapter, timers, queued sends) via a full navigation. */
export function hardReset(path = "/login"): void {
  endSession();
  bound = null;
  window.location.replace(path);
}
