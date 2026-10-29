/**
 * One browser = one session cookie, shared by every tab. A tab that was opened as user X keeps X's
 * in-memory session (keys, adapter, polling) after another tab logs out and signs in as Y, and its
 * requests would then carry Y's cookie: X's typed messages get sent as Y (P0, E2EE). Every tab records
 * which account it is bound to; all /api calls from the chat check it and refuse + hard-reload on mismatch.
 */
const KEY = "e2ee.activeUser";
let bound: string | null = null;

export class SessionChangedError extends Error {
  constructor() { super("Signed-in account changed in another tab"); this.name = "SessionChangedError"; }
}
const current = () => { try { return localStorage.getItem(KEY); } catch { return null; } };

/** The account whose cookie is now set (call after sign-in, before any navigation). "" = signed out. */
export function setActiveUser(userId: string): void { try { localStorage.setItem(KEY, userId); } catch { /* storage off */ } }

/** Bind this tab to `userId` (server-verified on page render). Reloads the tab if another tab switches account. */
export function bindTab(userId: string): () => void {
  bound = userId;
  setActiveUser(userId);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY && e.newValue !== userId) hardReset(); };
  window.addEventListener("storage", onStorage);
  return () => { window.removeEventListener("storage", onStorage); if (bound === userId) bound = null; };
}

/** Throw (and reset the tab) if this tab's account is no longer the browser's signed-in account. */
export function assertSameAccount(): void {
  if (bound === null) return;
  if (current() !== bound) { hardReset(); throw new SessionChangedError(); }
}

/** Drop all in-memory state (adapter, timers, queued sends) via a full navigation. */
export function hardReset(path = "/login"): void {
  bound = null;
  window.location.replace(path);
}
