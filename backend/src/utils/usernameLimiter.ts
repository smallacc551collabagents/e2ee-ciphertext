// Per-username sliding-window limiter for /auth/signin (credential-stuffing defence
// that still holds if the IP path is bypassed).
// NOTE: in-memory — resets per serverless cold start / not shared across instances.
// Acceptable interim; move to Redis (or similar) later.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const LOCKOUT_MS = 5 * 60 * 1000;
const MAX_KEYS = 50_000;

type Entry = { fails: number[]; lockedUntil: number };
const store = new Map<string, Entry>();

function prune(e: Entry, now: number) {
  e.fails = e.fails.filter((t) => now - t < WINDOW_MS);
}

/** Returns retry-after seconds if locked, else 0. Keyed by normalized username,
 *  independent of whether the account exists (no enumeration signal). */
export function usernameLocked(key: string, now = Date.now()): number {
  const e = store.get(key);
  if (!e) return 0;
  return e.lockedUntil > now ? Math.ceil((e.lockedUntil - now) / 1000) : 0;
}

export function recordFailure(key: string, now = Date.now()): void {
  if (store.size >= MAX_KEYS && !store.has(key)) {
    for (const [k, v] of store) {
      prune(v, now);
      if (v.fails.length === 0 && v.lockedUntil <= now) store.delete(k);
    }
    if (store.size >= MAX_KEYS) store.delete(store.keys().next().value as string);
  }
  const e = store.get(key) ?? { fails: [], lockedUntil: 0 };
  prune(e, now);
  e.fails.push(now);
  if (e.fails.length >= MAX_FAILURES) {
    e.lockedUntil = now + LOCKOUT_MS;
    e.fails = [];
  }
  store.set(key, e);
}

export function recordSuccess(key: string): void {
  store.delete(key);
}
