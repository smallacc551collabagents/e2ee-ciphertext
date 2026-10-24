import type { ChatAdapter } from "./types";
import { unavailableAdapter } from "./unavailable";
import { fixturesAdapter } from "./fixtures";
import { liveAdapter, type Me } from "./live";

/** Single swap point. Live E2EE chat is behind NEXT_PUBLIC_CHAT_LIVE=1 until rollout. */
export function chatAdapter(me?: Me): ChatAdapter {
  if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_CHAT_FIXTURES === "1") return fixturesAdapter;
  if (process.env.NEXT_PUBLIC_CHAT_LIVE === "1" && me && typeof window !== "undefined") return liveAdapter(me);
  return unavailableAdapter;
}
export * from "./types";
