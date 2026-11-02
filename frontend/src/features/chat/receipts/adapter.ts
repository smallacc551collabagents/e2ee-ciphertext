// Receipts/presence adapter. Read receipts are E2EE (crypto sendReadReceipt/decryptReceipt: Olm for 1:1,
// Megolm for groups, one receipt per batch carrying the highest seq read (upToSeq, monotonic)). There is no /receipts/read.
// Delivered-per-recipient and last seen come from the backend (existing acks; last-seen privacy toggle).
// Until those land, nullReceipts is used: UI shows single tick and no last seen. No fake data.
import type { Presence, ReadReceipt, RecipientReceipt } from "./model";

export interface ConversationReceipts { recipients: string[]; byMessage: Record<string, RecipientReceipt[]> }

export interface ReceiptsAdapter {
  /** Encrypt + send one read receipt for the highest message read (implemented via crypto sendReadReceipt). */
  sendRead(conversationId: string, upToSeq: number): Promise<void>;
  /** Other members (recipients) + per-recipient delivered/read for own messages, keyed by message id. */
  receipts(conversationId: string): Promise<ConversationReceipts>;
  /** Decrypted receipts from crypto receiveToDevice() ({conversationId, fromUserId, upToSeq, ts}); /sync/wait only wakes. */
  onReceipts(cb: (receipts: ReadReceipt[]) => void): () => void;
  /** Last seen keyed by username for the conversation's other members (empty if hidden/unknown). */
  presence(conversationId: string): Promise<Record<string, Presence>>;
  getLastSeenVisible(): Promise<boolean>;
  /** Hiding yours also hides others' from you (server-enforced). */
  setLastSeenVisible(visible: boolean): Promise<void>;
  /** False until backend/crypto contract is live: UI hides toggle state changes and last seen. */
  readonly available: boolean;
}

export const nullReceipts: ReceiptsAdapter = {
  available: false,
  sendRead: async () => undefined,
  receipts: async () => ({ recipients: [], byMessage: {} }),
  onReceipts: () => () => undefined,
  presence: async () => ({}),
  getLastSeenVisible: async () => true,
  setLastSeenVisible: async () => undefined,
};

let current: ReceiptsAdapter = nullReceipts;
export const receiptsAdapter = () => current;
/** Plug-in point for the live implementation once crypto + backend ship. */
export function setReceiptsAdapter(a: ReceiptsAdapter) { current = a; }
