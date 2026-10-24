-- Only UNUSED one-time prekeys must have unique key IDs per user, so a keyId that was
-- consumed before an identity rotation can be re-uploaded. Index-only change: no rows touched.
-- Create the partial index first (existing data already satisfies it, since the full index is stricter).
CREATE UNIQUE INDEX IF NOT EXISTS "one_time_prekeys_user_id_key_id_unused_key"
  ON "one_time_prekeys"("user_id", "key_id") WHERE "consumed_at" IS NULL;
DROP INDEX IF EXISTS "one_time_prekeys_user_id_key_id_key";
