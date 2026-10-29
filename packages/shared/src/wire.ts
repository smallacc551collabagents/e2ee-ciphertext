import { z } from "zod";
// Phase 1 HTTP wire contracts (backend/src/routes/transport.ts, keys routes). Single source for clients:
// the frontend imports these from @e2ee/shared; do not fork them.
// Keys and ciphertext are opaque standard-base64 bytes + integer version; their byte format
// belongs to packages/crypto. Never add inner structure here.
const b64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "standard base64");
const version = z.number().int().min(1).max(65535);
// Request schemas below are the backend's validation source (backend/src/routes/transport.ts):
// strict objects (unknown keys rejected) and bounds matching the server's limits.
export const USERNAME_PATTERN = /^[a-zA-Z0-9_.]{3,32}$/;
const usernameSchema = z.string().regex(USERNAME_PATTERN);
const keyIdSchema = z.number().int().min(0).max(2147483647);
const uuidSchema = z.string().regex(/^[0-9a-fA-F-]{36}$/);
export const KEY_MAX_BYTES = 1024;
export const CIPHERTEXT_MAX_BYTES = 32 * 1024;
export const b64Bytes = (s: string) => Math.floor((s.length * 3) / 4) - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
const capped = (max: number) => b64.min(4).max(Math.ceil(max / 3) * 4).refine((s) => b64Bytes(s) <= max, `≤ ${max} bytes`);

export const memberSchema = z.object({ id: z.string(), username: z.string() });
export const conversationSchema = z.object({
  id: z.string(),
  kind: z.enum(["direct", "group"]),
  lastSeq: z.string().optional(),
  createdAt: z.string().optional(),
  members: z.array(memberSchema),
});
export const conversationListSchema = z.object({ conversations: z.array(conversationSchema) });
export const createConversationRequestSchema = z.object({ username: usernameSchema }).strict();
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
// Optional: refs of attachments (completed by the sender in this conversation) this message carries.
// Lets the server keep those blobs while the message is undelivered (docs/attachments-backend.md).
export const ATTACHMENT_REFS_MAX = 10;
export const attachmentRefSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const sendMessageRequestSchema = z.object({
  clientMsgId: clientMsgIdSchema, ciphertext: capped(CIPHERTEXT_MAX_BYTES), version,
  attachmentRefs: z.array(attachmentRefSchema).max(ATTACHMENT_REFS_MAX).refine((a) => new Set(a).size === a.length, "unique items").optional(),
}).strict();
export const deleteAccountRequestSchema = z.object({ password: z.string().min(1).max(256) }).strict();
export const sendMessageResponseSchema = z.object({ message: messageSchema, duplicate: z.boolean() });
export const messagePageSchema = z.object({ messages: z.array(messageSchema), nextCursor: z.string().nullable(), hasMore: z.boolean() });
export const ackRequestSchema = z.object({ messageIds: z.array(uuidSchema).min(1).max(500).refine((a) => new Set(a).size === a.length, "unique items") }).strict();
export const ackResponseSchema = z.object({ acked: z.number().int().nonnegative() });

// Key shapes: strict for requests; responses (prekeyBundleSchema) use the non-strict base so fields the
// server adds later are stripped, not rejected. Rule: request schemas .strict(), response schemas never.
const pubKeyBase = z.object({ publicKey: capped(KEY_MAX_BYTES), version });
const signedPrekeyBase = z.object({ keyId: keyIdSchema, publicKey: capped(KEY_MAX_BYTES), signature: capped(KEY_MAX_BYTES), version });
const oneTimePrekeyBase = z.object({ keyId: keyIdSchema, publicKey: capped(KEY_MAX_BYTES), version });
const pubKey = pubKeyBase.strict();
const signedPrekey = signedPrekeyBase.strict();
const oneTimePrekey = oneTimePrekeyBase.strict();
export const publishKeysRequestSchema = z.object({
  identityKey: pubKey.optional(),
  signedPrekey: signedPrekey.optional(),
  oneTimePrekeys: z.array(oneTimePrekey).min(1).max(100).optional(),
}).strict().refine((o) => Object.keys(o).length > 0, "at least one of identityKey, signedPrekey, oneTimePrekeys");
export const usernameParamsSchema = z.object({ username: usernameSchema });
export const conversationParamsSchema = z.object({ id: uuidSchema });
export const messagePageQuerySchema = z.object({ after: z.string().regex(/^[0-9]{1,18}$/).optional(), limit: z.string().regex(/^[0-9]{1,3}$/).optional() }).strict();
export const prekeyCountSchema = z.object({ oneTimePrekeyCount: z.number().int().nonnegative() });
export const prekeyBundleSchema = z.object({
  userId: z.string(), username: z.string(),
  identityKey: pubKeyBase, signedPrekey: signedPrekeyBase, oneTimePrekey: oneTimePrekeyBase.nullable(),
});

export type ConversationWire = z.infer<typeof conversationSchema>;
export type MessageWire = z.infer<typeof messageSchema>;
export type PrekeyBundle = z.infer<typeof prekeyBundleSchema>;
export type PublishKeysRequest = z.infer<typeof publishKeysRequestSchema>;
