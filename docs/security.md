# Security

Owner: System Architecture/Supervisor.

## Rate limiting (E2EE-75 — resolved)

All rate limits use a **shared store in Neon Postgres** (`rate_limits` table, `backend/src/utils/rateLimiter.ts`), so they hold across serverless instances and cold starts. Before E2EE-75 they were in-memory per instance.

| Limit | Key | Rule | If the store fails |
|---|---|---|---|
| `/auth/signin` and `/auth/signup` per IP | `rl:auth:<ip>` | 20 per 15 min (fixed window) | **Fail closed** (500) |
| `/auth/signin` per username | `ufail:<u>` / `ulock:<u>` | 10 failures in a sliding 15 min → 5 min lockout; a successful signin clears it. Same 429 whether or not the account exists. | **Fail closed** (500) |
| `GET /keys/bundle/:username` per caller | `rl:bundle:<userId>` | 60/min | **Fail open**, logged |
| `GET /keys/bundle/:username` per target | `bundle-target:<u>` | 30/min | **Fail open**, logged |
| `POST /conversations/:id/messages` per caller | `rl:msg:<userId>` | 120/min | **Fail open**, logged |

How it works:
- **One round-trip per check.** Each check is an atomic `INSERT … ON CONFLICT (key) DO UPDATE … RETURNING`, with one row per key. A fixed window starts at the first hit, the same as the old in-memory limiter. Sliding limits keep a small, bounded array of recent hit timestamps. All windows use the database clock.
- **Bounded growth.** About 1% of checks run a cleanup that deletes at most 1000 expired rows, using the index on `expires_at`.
- **Fail-open or fail-closed.** Auth endpoints need the database anyway, so if the limiter is down they refuse the request instead of allowing unthrottled password guessing. Key and message routes fail open, so a limiter hiccup doesn't break messaging. Those routes still require authentication and payload caps.
- **Swappable.** Routes depend only on the `RateLimiter` interface, so a Redis implementation can replace `PgRateLimiter` without route changes.
