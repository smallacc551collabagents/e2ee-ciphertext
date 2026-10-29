import { z } from "zod";
// Phase 1 HTTP wire contracts (backend/src/routes/transport.ts, keys routes). Single source for clients:
// the frontend imports these from @e2ee/shared; do not fork them.
// Keys and ciphertext are opaque standard-base64 bytes + integer version; their byte format
// belongs to packages/crypto. Never add inner structure here.
const b64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "standard base64");
const version = z.number().int().min(1).max(65535);
export const KEY_MAX_BYTES = 1024;
export const CIPHERTEXT_MAX_BYTES = 32 * 1024;
export const b64Bytes = (s: string) => Math.floor((s.length * 3) / 4) - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
const capped = (max: number) => b64.refine((s) => b64Bytes(s) <= max, `≤ ${max} bytes`);

export const memberSchema = z.object({ id: z.string(), username: z.string() });
export const conversationSchema = z.object({
  id: z.string(),
  kind: z.enum(["direct", "group"]),
  lastSeq: z.string().optional(),
  createdAt: z.string().optional(),
  members: z.array(memberSchema),
});
export const conversationListSchema = z.object({ conversations: z.array(conversationSchema) });
export const createConversationRequestSchema = z.object({ username: z.string().min(1) });
export const createConversationResponseSchema = z.object({ conversation: conversationSchema });

export const clientMsgIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  senderId: z.string(),
  seq: z.string().regex(/^\d+$/),
  clientMsgId: z.string(),
  ciphertext: b64, // opaque; the server never sees plaintext
  version,
  createdAt: z.string(),
});
export const sendMessageRequestSchema = z.object({ clientMsgId: clientMsgIdSchema, ciphertext: capped(CIPHERTEXT_MAX_BYTES), version });
export const sendMessageResponseSchema = z.object({ message: messageSchema, duplicate: z.boolean() });
export const messagePageSchema = z.object({ messages: z.array(messageSchema), nextCursor: z.string().nullable(), hasMore: z.boolean() });
export const ackRequestSchema = z.object({ messageIds: z.array(z.string().uuid()).max(500) });
export const ackResponseSchema = z.object({ acked: z.number().int().nonnegative() });

const pubKey = z.object({ publicKey: capped(KEY_MAX_BYTES), version });
const signedPrekey = z.object({ keyId: z.number().int().nonnegative(), publicKey: capped(KEY_MAX_BYTES), signature: capped(KEY_MAX_BYTES), version });
const oneTimePrekey = z.object({ keyId: z.number().int().nonnegative(), publicKey: capped(KEY_MAX_BYTES), version });
export const publishKeysRequestSchema = z.object({
  identityKey: pubKey.optional(),
  signedPrekey: signedPrekey.optional(),
  oneTimePrekeys: z.array(oneTimePrekey).max(100).optional(),
});
export const prekeyCountSchema = z.object({ oneTimePrekeyCount: z.number().int().nonnegative() });
export const prekeyBundleSchema = z.object({
  userId: z.string(), username: z.string(),
  identityKey: pubKey, signedPrekey, oneTimePrekey: oneTimePrekey.nullable(),
});

export type ConversationWire = z.infer<typeof conversationSchema>;
export type MessageWire = z.infer<typeof messageSchema>;
export type PrekeyBundle = z.infer<typeof prekeyBundleSchema>;
export type PublishKeysRequest = z.infer<typeof publishKeysRequestSchema>;
