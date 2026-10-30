-- Group (Megolm) ciphertext never depends on the recipient identity; un-hide group deliveries that
-- were wrongly flagged undeliverable on an identity change.
UPDATE "message_deliveries" d SET "undeliverable_reason" = NULL
  FROM "messages" m JOIN "conversations" c ON c."id" = m."conversation_id"
 WHERE d."message_id" = m."id" AND c."kind" = 'group' AND d."undeliverable_reason" IS NOT NULL;
