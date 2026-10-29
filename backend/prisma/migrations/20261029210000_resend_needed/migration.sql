-- Resend-on-new-identity (additive only).
-- Stamp each pending delivery with a SHA-256 digest of the recipient's identity public key at send time.
-- NULL = sent before this migration (treated as "old identity" when the recipient's identity changes).
ALTER TABLE "message_deliveries" ADD COLUMN "recipient_identity_digest" BYTEA;

-- Per-sender list of messages that must be re-encrypted for a recipient's new identity.
CREATE TABLE "resend_needed" (
    "sender_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "client_msg_id" TEXT NOT NULL,
    "recipient_id" UUID NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'identity_changed',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "resend_needed_pkey" PRIMARY KEY ("sender_id", "conversation_id", "client_msg_id", "recipient_id")
);
CREATE INDEX "resend_needed_created_at_idx" ON "resend_needed"("created_at");
CREATE INDEX "resend_needed_recipient_id_idx" ON "resend_needed"("recipient_id");
ALTER TABLE "resend_needed" ADD CONSTRAINT "resend_needed_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "resend_needed" ADD CONSTRAINT "resend_needed_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "resend_needed" ADD CONSTRAINT "resend_needed_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
