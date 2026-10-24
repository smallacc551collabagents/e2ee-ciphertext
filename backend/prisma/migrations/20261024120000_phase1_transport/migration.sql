-- CreateTable
CREATE TABLE "identity_keys" (
    "user_id" UUID NOT NULL,
    "identity_key" BYTEA NOT NULL,
    "identity_key_version" INTEGER NOT NULL,
    "signed_prekey_id" INTEGER NOT NULL,
    "signed_prekey" BYTEA NOT NULL,
    "signed_prekey_signature" BYTEA NOT NULL,
    "signed_prekey_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_keys_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "one_time_prekeys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "key_id" INTEGER NOT NULL,
    "public_key" BYTEA NOT NULL,
    "version" INTEGER NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "one_time_prekeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'direct',
    "direct_key" TEXT,
    "last_seq" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_members" (
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_members_pkey" PRIMARY KEY ("conversation_id","user_id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "client_msg_id" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_deliveries" (
    "message_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "delivered_at" TIMESTAMPTZ(3),

    CONSTRAINT "message_deliveries_pkey" PRIMARY KEY ("message_id","recipient_id")
);

-- CreateIndex
CREATE INDEX "one_time_prekeys_user_id_consumed_at_idx" ON "one_time_prekeys"("user_id", "consumed_at");

-- CreateIndex
CREATE UNIQUE INDEX "one_time_prekeys_user_id_key_id_key" ON "one_time_prekeys"("user_id", "key_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_direct_key_key" ON "conversations"("direct_key");

-- CreateIndex
CREATE INDEX "conversation_members_user_id_idx" ON "conversation_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_seq_key" ON "messages"("conversation_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_sender_id_client_msg_id_key" ON "messages"("conversation_id", "sender_id", "client_msg_id");

-- CreateIndex
CREATE INDEX "message_deliveries_recipient_id_delivered_at_idx" ON "message_deliveries"("recipient_id", "delivered_at");

-- AddForeignKey
ALTER TABLE "identity_keys" ADD CONSTRAINT "identity_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "one_time_prekeys" ADD CONSTRAINT "one_time_prekeys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

