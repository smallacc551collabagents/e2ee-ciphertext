import type { ChatAdapter } from "./types";
import { unavailableAdapter } from "./unavailable";
import { fixturesAdapter } from "./fixtures";

/** Single swap point: replace unavailableAdapter with the HTTP+crypto adapter once contracts merge. */
export function chatAdapter(): ChatAdapter {
  if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_CHAT_FIXTURES === "1") return fixturesAdapter;
  return unavailableAdapter;
}
export * from "./types";
