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

/** Sending is blocked until the user re-verifies the peer's new safety number. */
export class IdentityChangedError extends Error {
  constructor(public readonly peerId: string) { super("Safety number changed"); }
}

/** Local device state (E2EE-79). "needs-new-device-confirmation": the account already has keys on another browser. */
export type DeviceState = "fresh" | "existing" | "needs-new-device-confirmation";

/** Thrown by live adapter calls until confirmNewDevice() when this browser would replace the account's device. */
export class NewDeviceRequiredError extends Error {
  readonly code = "NEW_DEVICE_CONFIRMATION_REQUIRED";
  constructor() { super("This browser is a new device; confirm before publishing new keys"); }
}

/** Why a peer's safety number changed. "new-device": peer signed in on a new browser; "key-changed": same device, different keys (unexpected). */
export type IdentityChangeKind = "new-device" | "key-changed";
export interface PeerIdentityChange { peerId: string; username: string; kind: IdentityChangeKind }

export interface SafetyInfo { digits: string[] | null; changed: boolean; changeKind?: IdentityChangeKind }

export interface ChatAdapter {
  readonly id: string;
  listConversations(): Promise<ConversationView[]>;
  listMessages(conversationId: string): Promise<MessageView[]>;
  sendMessage(conversationId: string, text: string, clientId: string): Promise<MessageView>;
  /** Optional: only adapters with real E2EE support attachments (button hidden otherwise). */
  sendAttachment?(conversationId: string, file: File, clientId: string, onPhase: (p: import("../attachments/flow").Phase, f?: number) => void): Promise<MessageView>;
  openAttachment?(descriptor: unknown, onPhase: (p: import("../attachments/flow").Phase, f?: number) => void): Promise<{ bytes: Uint8Array; name: string; mime: string }>;
  displayText?(s: string): string;
  /** Optional: safety number + identity-changed state (live adapter only). */
  safety?(conversationId: string): Promise<SafetyInfo>;
  acceptNewIdentity?(conversationId: string): Promise<void>;
  /** E2EE-79: check before rendering chat. Does not publish anything. */
  deviceState?(): Promise<DeviceState>;
  /** E2EE-79: user confirmed "use this browser as my new device" -> publish the new identity. */
  confirmNewDevice?(): Promise<void>;
  /** E2EE-79: pending peer identity change for a conversation (null if none). Sending stays blocked until acceptNewIdentity. */
  peerChange?(conversationId: string): Promise<PeerIdentityChange | null>;
  /** Start (or reopen) a direct conversation. Existing conversations are returned, not duplicated. */
  createConversation?(username: string): Promise<ConversationView>;
}
