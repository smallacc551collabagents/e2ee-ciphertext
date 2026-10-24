// Fixed-window in-memory counter (per serverless instance; shared store tracked in E2EE-75).
export function windowLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; resetAt: number }>();
  /** Returns seconds until reset if `key` is over the limit, else 0 (and counts the hit). */
  return (key: string, now = Date.now()): number => {
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    const e = hits.get(key);
    if (!e || e.resetAt <= now) { hits.set(key, { n: 1, resetAt: now + windowMs }); return 0; }
    if (e.n >= max) return Math.ceil((e.resetAt - now) / 1000);
    e.n++;
    return 0;
  };
}
