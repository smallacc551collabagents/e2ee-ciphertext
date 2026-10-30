import { z } from "zod";
// Phase 1 HTTP wire contracts (backend/src/routes/transport.ts, keys routes). Single source for clients:
// the frontend imports these from @e2ee/shared; do not fork them.
// Keys and ciphertext are opaque standard-base64 bytes + integer version; their byte format
// belongs to packages/crypto. Never add inner structure here.
const b64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "standard base64");
const version = z.number().int().min(1).max(65535);
// Request schemas below are the backend's validation source (backend/src/routes/transport.ts):
// strict objects (unknown keys rejected) and bounds matching the server's limits.
// Auth limits: single source for backend (routes/auth.ts) and frontend.
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 64;
export const PASSWORD_MIN = 1;
export const PASSWORD_MAX = 1024; // hard cap: argon2 on unbounded input is a DoS vector
export const USERNAME_PATTERN_SOURCE = `^[a-zA-Z0-9_.]{${USERNAME_MIN},${USERNAME_MAX}}$`;
export const USERNAME_PATTERN = new RegExp(USERNAME_PATTERN_SOURCE);
const usernameSchema = z.string().regex(USERNAME_PATTERN);
const keyIdSchema = z.number().int().min(0).max(2147483647);
const uuidSchema = z.string().regex(/^[0-9a-fA-F-]{36}$/);
export const KEY_MAX_BYTES = 1024;
export const CIPHERTEXT_MAX_BYTES = 32 * 1024;
export const b64Bytes = (s: string) => Math.floor((s.length * 3) / 4) - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
const capped = (max: number) => b64.min(4).max(Math.ceil(max / 3) * 4).refine((s) => b64Bytes(s) <= max, `≤ ${max} bytes`);

export const memberSchema = z.object({ id: z.string(), username: z.string(), joinedAt: z.string().optional() });
// Groups (Phase 6, Megolm): kind "group" adds adminId (creator; never removable), membershipVersion (bumped
// on every add/remove/leave/admin change) and optional opaque encryptedMeta (e.g. encrypted group name).
export const GROUP_MAX_MEMBERS = 50;
export const GROUP_META_MAX_BYTES = 2048;
export const conversationSchema = z.object({
  id: z.string(),
  kind: z.enum(["direct", "group"]),
  lastSeq: z.string().optional(),
  createdAt: z.string().optional(),
  members: z.array(memberSchema),
  adminId: z.string().nullable().optional(),
  membershipVersion: z.number().int().nonnegative().optional(),
  encryptedMeta: z.string().nullable().optional(),
});
export const conversationListSchema = z.object({ conversations: z.array(conversationSchema) });
export const createConversationRequestSchema = z.object({ username: usernameSchema }).strict();
export const createConversationResponseSchema = z.object({ conversation: conversationSchema });

const usernameList = z.array(usernameSchema).min(1).max(GROUP_MAX_MEMBERS - 1)
  .refine((a) => new Set(a.map((u) => u.toLowerCase())).size === a.length, "unique items");
// POST /groups -> 201 createConversationResponseSchema. Every member must be someone the creator has a 1:1 with.
export const createGroupRequestSchema = z.object({
  members: usernameList, encryptedMeta: capped(GROUP_META_MAX_BYTES).optional(),
}).strict();
// POST /groups/:id/members -> 200 createConversationResponseSchema.
export const addGroupMembersRequestSchema = z.object({ usernames: usernameList }).strict();
export const groupMemberParamsSchema = z.object({ id: z.string().regex(/^[0-9a-fA-F-]{36}$/), username: usernameSchema });
// Group error codes (body { error, message, ... }).
export const GROUP_ERRORS = {
  cannotRemoveAdmin: "cannot_remove_admin", // 403
  notAContact: "not_a_contact", // 403 (+ usernames)
  groupFull: "group_full", // 409
  membershipChanged: "membership_changed", // 409 (+ membershipVersion, members)
  notAGroup: "not_a_group", // 400
  alreadyMember: "already_member", // 409 (+ usernames)
  notMember: "not_member", // 404 target not in group
} as const;
export const membershipChangedErrorSchema = z.object({
  error: z.literal("membership_changed"), message: z.string(),
  membershipVersion: z.number().int().nonnegative(), members: z.array(memberSchema),
});
export const systemEventSchema = z.object({
  type: z.enum(["group_created", "member_added", "member_removed", "member_left", "admin_changed"]),
  actor: z.string().nullable(), actorUsername: z.string().nullable().optional(),
  target: z.string().nullable(), targetUsername: z.string().nullable().optional(),
  membershipVersion: z.number().int().nonnegative(),
});

export const clientMsgIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  senderId: z.string(),
  seq: z.string().regex(/^\d+$/),
  clientMsgId: z.string(),
  ciphertext: b64, // opaque; the server never sees plaintext ("" for kind "system")
  version,
  createdAt: z.string(),
  // Groups: server-generated membership events share the seq stream. Absent kind = "message".
  kind: z.enum(["message", "system"]).optional(),
  event: systemEventSchema.optional(),
});
// Optional: refs of attachments (completed by the sender in this conversation) this message carries.
// Lets the server keep those blobs while the message is undelivered (docs/attachments-backend.md).
export const ATTACHMENT_REFS_MAX = 10;
export const attachmentRefSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const sendMessageRequestSchema = z.object({
  clientMsgId: clientMsgIdSchema, ciphertext: capped(CIPHERTEXT_MAX_BYTES), version,
  attachmentRefs: z.array(attachmentRefSchema).max(ATTACHMENT_REFS_MAX).refine((a) => new Set(a).size === a.length, "unique items").optional(),
  // Groups: the membershipVersion the Megolm session was shared for. Stale -> 409 membership_changed.
  membershipVersion: z.number().int().nonnegative().optional(),
}).strict();
export const deleteAccountRequestSchema = z.object({ password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX) }).strict();
export const sendMessageResponseSchema = z.object({ message: messageSchema, duplicate: z.boolean() });
export const messagePageSchema = z.object({ messages: z.array(messageSchema), nextCursor: z.string().nullable(), hasMore: z.boolean() });
// Resend-on-new-identity: GET /conversations/:id/undeliverable -> own messages whose recipient published a
// new identity before fetching. Re-encrypt to the new bundle and POST with the SAME clientMsgId: the server
// replaces ciphertext/version in place (same id + seq) and returns duplicate:false.
export const UNDELIVERABLE_DEVICE_CHANGED = "undeliverable_device_changed" as const;
export const undeliverableItemSchema = z.object({
  messageId: z.string(), clientMsgId: z.string(), seq: z.string().regex(/^\d+$/), recipientId: z.string(),
  reason: z.string(),
});
export const undeliverableListSchema = z.object({ undeliverable: z.array(undeliverableItemSchema) });
export const ackRequestSchema = z.object({ messageIds: z.array(uuidSchema).min(1).max(500).refine((a) => new Set(a).size === a.length, "unique items") }).strict();
export const ackResponseSchema = z.object({ acked: z.number().int().nonnegative() });

// To-device (Olm 1:1 envelopes carrying Megolm room keys). Recipient must share a conversation with the sender.
export const TO_DEVICE_BATCH_MAX = 100;
export const toDeviceOutgoingSchema = z.object({
  recipient: usernameSchema, ciphertext: capped(CIPHERTEXT_MAX_BYTES), type: z.number().int().min(0).max(65535), version,
}).strict();
export const sendToDeviceRequestSchema = z.object({ messages: z.array(toDeviceOutgoingSchema).min(1).max(TO_DEVICE_BATCH_MAX) }).strict();
export const sendToDeviceResponseSchema = z.object({ sent: z.number().int().nonnegative() });
export const toDeviceMessageSchema = z.object({
  id: z.string(), senderId: z.string(), senderUsername: z.string(), ciphertext: b64, type: z.number().int(), version, createdAt: z.string(),
});
export const toDeviceListSchema = z.object({ messages: z.array(toDeviceMessageSchema), hasMore: z.boolean() });
export const toDeviceQuerySchema = z.object({ limit: z.string().regex(/^[0-9]{1,3}$/).optional() }).strict();
export const toDeviceAckRequestSchema = z.object({ ids: z.array(uuidSchema).min(1).max(500).refine((a) => new Set(a).size === a.length, "unique items") }).strict();

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
export type UndeliverableWire = z.infer<typeof undeliverableItemSchema>;
export type SystemEventWire = z.infer<typeof systemEventSchema>;
export type ToDeviceMessageWire = z.infer<typeof toDeviceMessageSchema>;
export type CreateGroupRequest = z.infer<typeof createGroupRequestSchema>;
export type MessageWire = z.infer<typeof messageSchema>;
export type PrekeyBundle = z.infer<typeof prekeyBundleSchema>;
export type PublishKeysRequest = z.infer<typeof publishKeysRequestSchema>;

// ---------- realtime long-poll (GET /sync/wait) ----------
// Doorbell only: never acks or returns content. `cursor` is opaque; echo the last one you got.
// v2 = membership state + high-water marks of pending messages / to-device already reported to the caller.
// A v1 cursor is accepted and treated like no `since`.
export const SYNC_WAIT_MAX_SECONDS = 25;
const n15 = "[0-9]{1,15}";
export const syncCursorSchema = z.string().regex(new RegExp(`^v2(\\.${n15}){7}$`));
export const syncSinceSchema = z.union([syncCursorSchema, z.string().regex(new RegExp(`^v1(\\.${n15}){3}$`))]);
export const syncWaitQuerySchema = z.object({
  since: syncSinceSchema.optional(),
  timeout: z.string().regex(/^[0-9]{1,2}$/).optional(),
}).strict();
export const syncWaitResponseSchema = z.object({
  changed: z.boolean(),
  cursor: syncCursorSchema,
  conversations: z.array(z.string()),
  toDevice: z.boolean(),
});
export type SyncWaitResponse = z.infer<typeof syncWaitResponseSchema>;
