-- E2EE-47: encrypted attachment blobs (additive only).
-- Only OPAQUE metadata: random ref, owner, conversation, ciphertext size and ciphertext sha256.
-- Never file names, MIME types, keys or plaintext (those live only inside Olm messages).
CREATE TABLE "attachments" (
    "ref" TEXT NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("ref"),
    CONSTRAINT "attachments_status_check" CHECK ("status" IN ('pending', 'stored'))
);

CREATE INDEX "attachments_expires_at_idx" ON "attachments"("expires_at");
CREATE INDEX "attachments_owner_user_id_created_at_idx" ON "attachments"("owner_user_id", "created_at");

ALTER TABLE "attachments" ADD CONSTRAINT "attachments_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
