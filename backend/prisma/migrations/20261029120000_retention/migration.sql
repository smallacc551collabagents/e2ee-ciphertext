-- Message retention + reference-aware attachment retention (additive only).
CREATE TABLE "message_attachments" (
    "message_id" UUID NOT NULL,
    "ref" TEXT NOT NULL,
    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("message_id", "ref")
);
CREATE INDEX "message_attachments_ref_idx" ON "message_attachments"("ref");
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_ref_fkey" FOREIGN KEY ("ref") REFERENCES "attachments"("ref") ON DELETE CASCADE ON UPDATE CASCADE;

-- Sweep: 30-day cutoff scan on messages.
CREATE INDEX "messages_created_at_idx" ON "messages"("created_at");
-- Sweep: "does this message still have an undelivered recipient?" (partial, stays small).
CREATE INDEX "message_deliveries_pending_idx" ON "message_deliveries"("message_id") WHERE "delivered_at" IS NULL;
