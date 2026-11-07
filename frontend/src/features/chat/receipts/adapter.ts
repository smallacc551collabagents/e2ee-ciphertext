// Receipts/presence adapter. Read receipts are E2EE (crypto sendReadReceipt: Olm to each author's device,
// one receipt per batch carrying the highest seq read). There is no /receipts/read.
// Delivered watermarks and last seen come from GET /conversations; privacy from /me/privacy; heartbeat from
// POST /presence/heartbeat. nullReceipts is the default until installLiveReceipts() (no fake ticks or last seen).
import type { Presence, ReadReceipt, RecipientReceipt } from "./model";

export interface ConversationReceipts { recipients: string[]; byMessage: Record<string, RecipientReceipt[]> }

export interface ReceiptsAdapter {
  /** Encrypt + send one read receipt for the highest message read (implemented via crypto sendReadReceipt). */
  sendRead(conversationId: string, upToSeq: string | bigint): Promise<void>;
  /** Other members + per-recipient delivered/read for own messages, keyed by message id.
   *  `own` is the on-screen messages (id + seq). When passed, it wins over the in-memory thread. */
  receipts(conversationId: string, own?: readonly { id: string; seq: string }[]): Promise<ConversationReceipts>;
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
const waiters = new Set<() => void>();
export const receiptsAdapter = () => current;
/** Plug-in point. Notifies subscribers so a late install (settings, hydration) is picked up. */
export function setReceiptsAdapter(a: ReceiptsAdapter) {
  if (a === current) return;
  current = a;
  for (const l of [...waiters]) l();
}
export function onReceiptsAdapterChange(cb: () => void): () => void {
  waiters.add(cb);
  return () => waiters.delete(cb);
}
