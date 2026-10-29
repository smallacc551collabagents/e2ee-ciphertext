import type { IdentityChangeKind } from "./data/types";

/** Both kinds are warnings that block sending until the user verifies; wording must never reassure. */
export function identityWarning(name: string, kind: IdentityChangeKind | undefined): string {
  if (kind === "key-changed") return `Warning: ${name}’s security key changed unexpectedly on the same device. This can mean someone is intercepting the conversation. Verify the safety number with ${name} in person or on a call before continuing.`;
  return `${name}’s security key changed (reported as a new device). Verify the safety number before continuing.`;
}

export function changeKindLabel(kind: IdentityChangeKind | undefined): string | null {
  if (kind === "key-changed") return "Key changed on the same device (unexpected)";
  if (kind === "new-device") return "Reported as a new device";
  return null;
}

export const NEW_DEVICE_COPY = {
  title: "Use this browser as your new device?",
  body: "Your account is already set up on another browser. Messages are end-to-end encrypted and stored only on the device that received them, so your message history from the old browser won’t carry over here. Continuing creates new security keys for this browser, and the people you chat with will be asked to verify your new safety number.",
  confirm: "Use this browser",
} as const;
