-- Resend-on-new-identity (additive only).
-- recipient_identity_digest: SHA-256 of the recipient's identity public key at send time (NULL = legacy row,
-- treated as "old identity" when the recipient's identity changes).
-- undeliverable_reason: set to 'undeliverable_device_changed' when the recipient published a new identity
-- before fetching; the row is hidden from that recipient until the sender re-sends (same clientMsgId).
ALTER TABLE "message_deliveries" ADD COLUMN "recipient_identity_digest" BYTEA;
ALTER TABLE "message_deliveries" ADD COLUMN "undeliverable_reason" TEXT;
CREATE INDEX "message_deliveries_undeliverable_idx" ON "message_deliveries"("message_id") WHERE "undeliverable_reason" IS NOT NULL;
