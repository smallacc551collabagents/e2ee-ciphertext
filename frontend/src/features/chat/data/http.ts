import type { z } from "zod";
import { ApiError } from "@/lib/api/client";
import * as w from "@e2ee/shared";

// Typed client for Backend Phase 1 (PR #13). Not wired into the UI until #13 merges and
// packages/crypto exposes encrypt/decrypt; see ./index.ts for the single swap point.
async function call<S extends z.ZodTypeAny>(schema: S, path: string, init?: { method?: string; body?: unknown }): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init?.method ?? "GET",
      credentials: "same-origin",
      headers: init?.body ? { "Content-Type": "application/json" } : {},
      body: init?.body ? JSON.stringify(init.body) : null,
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "network_error", "Can't reach the server.");
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = json as { error?: string; message?: string } | null;
    throw new ApiError(res.status, e?.error ?? "unknown_error", e?.message ?? "Something went wrong.");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError(res.status, "bad_response", "Unexpected server response.");
  return parsed.data;
}

export const chatApi = {
  listConversations: () => call(w.conversationListSchema, "/conversations"),
  createConversation: (username: string) => call(w.createConversationResponseSchema, "/conversations", { method: "POST", body: w.createConversationRequestSchema.parse({ username }) }),
  listMessages: (id: string, after?: string, limit = 100) =>
    call(w.messagePageSchema, `/conversations/${encodeURIComponent(id)}/messages?${new URLSearchParams({ ...(after ? { after } : {}), limit: String(limit) })}`),
  sendMessage: (id: string, req: z.input<typeof w.sendMessageRequestSchema>) =>
    call(w.sendMessageResponseSchema, `/conversations/${encodeURIComponent(id)}/messages`, { method: "POST", body: w.sendMessageRequestSchema.parse(req) }),
  /** Never sends an empty list (server rejects it); de-duplicates and chunks to the 500-id cap. */
  async ack(messageIds: string[]): Promise<{ acked: number }> {
    const ids = [...new Set(messageIds)];
    let acked = 0;
    for (let i = 0; i < ids.length; i += 500) {
      acked += (await call(w.ackResponseSchema, "/messages/ack", { method: "POST", body: w.ackRequestSchema.parse({ messageIds: ids.slice(i, i + 500) }) })).acked;
    }
    return { acked };
  },
  publishKeys: (req: w.PublishKeysRequest) => call(w.prekeyCountSchema, "/keys/publish", { method: "POST", body: w.publishKeysRequestSchema.parse(req) }),
  prekeyCount: () => call(w.prekeyCountSchema, "/keys/count"),
  prekeyBundle: (username: string) => call(w.prekeyBundleSchema, `/keys/bundle/${encodeURIComponent(username)}`),
};
