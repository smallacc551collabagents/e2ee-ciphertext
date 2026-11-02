-- Last seen (server-side presence metadata) + per-member delivery watermark (survives message deletion).
ALTER TABLE "users" ADD COLUMN "last_seen_at" TIMESTAMPTZ(3);
ALTER TABLE "users" ADD COLUMN "hide_last_seen" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "conversation_members" ADD COLUMN "delivered_seq" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "conversation_members" ADD COLUMN "delivered_at" TIMESTAMPTZ(3);
