// Per-username sliding-window limiter for /auth/signin (credential-stuffing defence that
// still holds if the IP path is bypassed). E2EE-75: state lives in the shared store, so it
// survives cold starts and is shared across instances. Keyed by normalized username,
// independent of whether the account exists (no enumeration signal).
import { limiter } from "./rateLimiter.js";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const LOCKOUT_MS = 5 * 60 * 1000;

const failKey = (u: string) => `ufail:${u}`;
const lockKey = (u: string) => `ulock:${u}`;

/** Returns retry-after seconds if locked, else 0. */
export async function usernameLocked(key: string): Promise<number> {
  return limiter().lockedFor(lockKey(key));
}

/** 10 failures within a sliding 15 min => 5 min lockout; the failure history then resets. */
export async function recordFailure(key: string): Promise<void> {
  const fails = await limiter().slidingHit(failKey(key), WINDOW_MS);
  if (fails >= MAX_FAILURES) {
    await limiter().lock(lockKey(key), LOCKOUT_MS);
    await limiter().reset(failKey(key));
  }
}

export async function recordSuccess(key: string): Promise<void> {
  await limiter().reset(failKey(key), lockKey(key));
}
