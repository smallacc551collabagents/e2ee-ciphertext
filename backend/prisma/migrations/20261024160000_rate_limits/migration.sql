-- E2EE-75: shared rate-limit state (additive only).
-- One row per limiter key. Fixed windows are anchored at the first hit (same semantics as
-- the previous in-memory limiter); atomic increment via INSERT ... ON CONFLICT DO UPDATE.
-- "hits" holds recent hit timestamps for sliding-window limits (bounded by the limit size).
CREATE TABLE "rate_limits" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "window_start" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "hits" TIMESTAMPTZ(3)[],

    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("key")
);

-- Supports the opportunistic cleanup sweep (DELETE ... WHERE expires_at < now()).
CREATE INDEX "rate_limits_expires_at_idx" ON "rate_limits"("expires_at");
