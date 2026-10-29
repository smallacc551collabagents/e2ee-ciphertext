-- Group chat (Phase 6, Megolm). Additive only.
ALTER TABLE "conversations" ADD COLUMN "admin_id" UUID;
ALTER TABLE "conversations" ADD COLUMN "membership_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "conversations" ADD COLUMN "encrypted_meta" BYTEA;
-- Seq at join time: a member only sees messages with seq > joined_seq (no pre-join history).
ALTER TABLE "conversation_members" ADD COLUMN "joined_seq" BIGINT NOT NULL DEFAULT 0;
-- Server-generated membership events in the message stream (ciphertext empty for these rows).
ALTER TABLE "messages" ADD COLUMN "system_event" JSONB;

-- Olm to-device envelopes (Megolm room-key shares), queued per recipient until acked or 30 days.
CREATE TABLE "to_device_messages" (
    "id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "type" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "to_device_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "to_device_messages_recipient_idx" ON "to_device_messages"("recipient_id", "created_at");
CREATE INDEX "to_device_messages_created_at_idx" ON "to_device_messages"("created_at");
ALTER TABLE "to_device_messages" ADD CONSTRAINT "to_device_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "to_device_messages" ADD CONSTRAINT "to_device_messages_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ALTER COLUMN "sender_id" DROP NOT NULL; -- NULL = server system event
