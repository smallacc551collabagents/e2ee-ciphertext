import type { ChatAdapter } from "./types";
import { fixturesAdapter } from "./fixtures";
import { liveAdapter, type Me } from "./live";

/** Single swap point. Production = real Olm adapter (liveAdapter); fixtures only in non-prod dev. */
export function chatAdapter(me?: Me): ChatAdapter {
  if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_CHAT_FIXTURES === "1") return fixturesAdapter;
  if (!me) throw new Error("chatAdapter requires the signed-in user");
  return liveAdapter(me);
}
export * from "./types";
