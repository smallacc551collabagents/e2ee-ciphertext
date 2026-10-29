import { ApiError } from "@/lib/api/client";

import { USERNAME_PATTERN } from "@e2ee/shared";
export { USERNAME_PATTERN };

/** Returns an error message, or null when the username is acceptable. */
export function validatePeerUsername(raw: string, self: string): string | null {
  const u = raw.trim().replace(/^@/, "");
  if (!u) return "Enter a username.";
  if (!USERNAME_PATTERN.test(u)) return "Usernames are 3–32 letters, numbers, dots or underscores.";
  if (u.toLowerCase() === self.toLowerCase()) return "You can’t start a chat with yourself.";
  return null;
}

export function newChatErrorMessage(e: unknown, username: string): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return `No user named “${username}”.`;
    if (e.status === 400 && e.code === "self_conversation") return "You can’t start a chat with yourself.";
    if (e.status === 400) return "That username isn’t valid.";
    if (e.status === 401) return "Your session expired. Sign in again.";
    if (e.status === 429) return "Too many attempts. Try again shortly.";
    if (e.status === 0) return "Can’t reach the server. Check your connection.";
  }
  return "Couldn’t start the chat. Try again.";
}
