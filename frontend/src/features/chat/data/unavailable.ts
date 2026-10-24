import { FeatureUnavailableError, type ChatAdapter } from "./types";

// Production default until Backend Phase 1 (PR #13) merges and packages/crypto ships encrypt/decrypt.
// and Crypto's envelope API are merged. Renders the "coming soon" state; never fake data.
const missing = "Backend Phase 1 (PR #13: /conversations, /conversations/:id/messages, /keys/*) + packages/crypto encrypt/decrypt";
export const unavailableAdapter: ChatAdapter = {
  id: "unavailable",
  listConversations: () => Promise.reject(new FeatureUnavailableError(missing)),
  listMessages: () => Promise.reject(new FeatureUnavailableError(missing)),
  sendMessage: () => Promise.reject(new FeatureUnavailableError(missing)),
};
