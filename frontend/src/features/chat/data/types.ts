// View model the UI renders. Produced by a ChatAdapter (fetch wire data + decrypt locally).
export type MessageStatus = "sending" | "sent" | "delivered" | "read" | "failed";

export interface ConversationView {
  id: string;
  name: string;
  preview: string;
  lastActivityAt: string; // ISO
  unread: number;
}

export interface MessageView {
  id: string;
  clientId?: string;
  fromMe: boolean;
  text: string; // decrypted plaintext; rendered as text only, never HTML
  sentAt: string; // ISO
  status: MessageStatus;
  /** Untrusted attachment descriptor from inside the decrypted message (re-validated on open). */
  attachment?: unknown;
}

/** Thrown by adapters whose backend/crypto contract isn't available yet. */
export class FeatureUnavailableError extends Error {
  constructor(public readonly missing: string) {
    super(`Not available yet: ${missing}`);
  }
}

export interface ChatAdapter {
  readonly id: string;
  listConversations(): Promise<ConversationView[]>;
  listMessages(conversationId: string): Promise<MessageView[]>;
  sendMessage(conversationId: string, text: string, clientId: string): Promise<MessageView>;
  /** Optional: only adapters with real E2EE support attachments (button hidden otherwise). */
  sendAttachment?(conversationId: string, file: File, clientId: string, onPhase: (p: import("../attachments/flow").Phase, f?: number) => void): Promise<MessageView>;
  openAttachment?(descriptor: unknown, onPhase: (p: import("../attachments/flow").Phase, f?: number) => void): Promise<{ bytes: Uint8Array; name: string; mime: string }>;
  displayText?(s: string): string;
}
