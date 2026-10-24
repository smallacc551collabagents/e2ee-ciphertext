// E2EE-75: shared rate limiting. State lives in Postgres (Neon) so limits hold across
// serverless instances and cold starts. The RateLimiter interface is storage-agnostic so a
// Redis implementation can be dropped in later without touching routes.
//
// Every check is ONE round-trip: an atomic INSERT ... ON CONFLICT DO UPDATE ... RETURNING.
// Windows use the DB clock, so all instances agree. Row growth is capped by an
// opportunistic, bounded sweep of expired rows on ~1% of hits.
import { q } from "../database/db.js";

export interface RateLimiter {
  /** Fixed window anchored at the first hit. Counts this hit; returns the window's count and ms until reset. */
  hit(key: string, windowMs: number): Promise<{ count: number; resetMs: number }>;
  /** Sliding window: records this hit and returns how many hits fall in the last `windowMs`. */
  slidingHit(key: string, windowMs: number): Promise<number>;
  /** Seconds remaining on a lock for `key`, or 0. */
  lockedFor(key: string): Promise<number>;
  /** Set/extend a lock on `key` for `ms`. */
  lock(key: string, ms: number): Promise<void>;
  /** Drop all state for the given keys. */
  reset(...keys: string[]): Promise<void>;
}

const CLEANUP_PROBABILITY = 0.01;
const ms = "make_interval(secs => $2::float8 / 1000)";

export class PgRateLimiter implements RateLimiter {
  constructor(private readonly log: (err: unknown) => void = () => undefined) {}

  async hit(key: string, windowMs: number): Promise<{ count: number; resetMs: number }> {
    // In ON CONFLICT DO UPDATE, rate_limits.* is the OLD row, so all CASEs see the same state.
    const r = await q().query<{ count: number; reset_ms: number }>(
      `INSERT INTO rate_limits (key, count, window_start, expires_at) VALUES ($1, 1, now(), now() + ${ms})
       ON CONFLICT (key) DO UPDATE SET
         count        = CASE WHEN rate_limits.expires_at <= now() THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN rate_limits.expires_at <= now() THEN now() ELSE rate_limits.window_start END,
         expires_at   = CASE WHEN rate_limits.expires_at <= now() THEN EXCLUDED.expires_at ELSE rate_limits.expires_at END
       RETURNING count, (extract(epoch FROM expires_at - now()) * 1000)::float8 AS reset_ms`,
      [key, windowMs],
    );
    this.maybeCleanup();
    const row = r.rows[0]!;
    return { count: Number(row.count), resetMs: Math.max(Number(row.reset_ms), 1) };
  }

  async slidingHit(key: string, windowMs: number): Promise<number> {
    const r = await q().query<{ n: number }>(
      `INSERT INTO rate_limits (key, count, window_start, expires_at, hits) VALUES ($1, 1, now(), now() + ${ms}, ARRAY[now()]::timestamptz[])
       ON CONFLICT (key) DO UPDATE SET
         hits = array_append(ARRAY(SELECT t FROM unnest(rate_limits.hits) t WHERE t > now() - ${ms} ORDER BY t), now()),
         expires_at = EXCLUDED.expires_at
       RETURNING cardinality(hits) AS n`,
      [key, windowMs],
    );
    this.maybeCleanup();
    return Number(r.rows[0]!.n);
  }

  async lockedFor(key: string): Promise<number> {
    const r = await q().query<{ s: number }>(
      `SELECT ceil(extract(epoch FROM expires_at - now()))::int AS s FROM rate_limits WHERE key = $1 AND expires_at > now()`, [key]);
    return Math.max(Number(r.rows[0]?.s ?? 0), 0);
  }

  async lock(key: string, lockMs: number): Promise<void> {
    await q().query(
      `INSERT INTO rate_limits (key, count, window_start, expires_at) VALUES ($1, 1, now(), now() + ${ms})
       ON CONFLICT (key) DO UPDATE SET window_start = now(), expires_at = EXCLUDED.expires_at`, [key, lockMs]);
  }

  async reset(...keys: string[]): Promise<void> {
    await q().query(`DELETE FROM rate_limits WHERE key = ANY($1::text[])`, [keys]);
  }

  private maybeCleanup(): void {
    if (Math.random() >= CLEANUP_PROBABILITY) return;
    this.cleanup().catch((e) => this.log(e));
  }

  /** Bounded sweep of expired rows (index on expires_at); never more than 1000 rows per call. */
  async cleanup(): Promise<void> {
    await q().query(
      `DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires_at < now() LIMIT 1000)`);
  }
}

let logError: (err: unknown) => void = () => undefined;
/** Wire the app logger in for background (cleanup) failures. */
export function setRateLimitLogger(fn: (err: unknown) => void): void { logError = fn; }
let shared: RateLimiter = new PgRateLimiter((e) => logError(e));
export const limiter = (): RateLimiter => shared;
/** Swap the backing store (e.g. Redis later, or a failing stub in tests). */
export function setRateLimiter(l: RateLimiter): void { shared = l; }

/** @fastify/rate-limit store adapter backed by the shared RateLimiter. */
export class SharedStore {
  incr(key: string, cb: (err: Error | null, res?: { current: number; ttl: number }) => void, timeWindow: number): void {
    limiter().hit(`rl:${key}`, timeWindow).then((r) => cb(null, { current: r.count, ttl: r.resetMs }), (e: Error) => cb(e));
  }
  child(): SharedStore { return this; }
}

/** Fixed-window check: counts the hit; returns retry-after seconds if `key` is now over `max`, else 0. */
export async function overLimit(key: string, max: number, windowMs: number): Promise<number> {
  const r = await limiter().hit(key, windowMs);
  return r.count > max ? Math.ceil(r.resetMs / 1000) : 0;
}
