// Live adapter: Phase 1 backend (#13/#19) + packages/crypto (#16/#20). The frontend does
// no key mapping: it only calls the crypto package's adapter/bridge and the HTTP API.
// WASM loads client-side via dynamic import; keys live in IndexedDB (crypto package).
import type { BackendHttp, CryptoAdapter, DeviceIdentity, ReceiveResult } from "@e2ee/crypto";
import { chatApi } from "./http";
import { idbKv } from "./idb";
import { IdentityChangedError, type ChatAdapter, type ConversationView, type MessageView, type SafetyInfo } from "./types";
import type { ConversationWire } from "./wire";

export interface Me { id: string; username: string }

const http: BackendHttp = {
  async request(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method, credentials: "same-origin", cache: "no-store",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body: json });
    return json;
  },
};

function deviceIdFor(username: string): string {
  const k = `e2ee.deviceId.${username}`;
  let id = localStorage.getItem(k);
  if (!id) { id = crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase(); localStorage.setItem(k, id); }
  return id;
}

export function liveAdapter(me: Me): ChatAdapter {
  const texts = idbKv<string>(`e2ee-plaintext-${me.username}`);
  const peers = idbKv<{ identity: DeviceIdentity; checkedAt: number }>(`e2ee-peers-${me.username}`);
  const convos = new Map<string, ConversationWire>();
  const changed = new Map<string, DeviceIdentity>(); // peer userId -> new published identity
  let ctx: Promise<{ c: typeof import("@e2ee/crypto"); adapter: CryptoAdapter; verifier: ReturnType<typeof import("@e2ee/crypto").createPeerVerifier> }> | null = null;

  const note = (rs: readonly { userId: string; status: string; current?: DeviceIdentity }[]) => {
    for (const r of rs) if (r.status === "changed" && r.current) changed.set(r.userId, r.current);
  };

  function init() {
    ctx ??= (async () => {
      const c = await import("@e2ee/crypto");
      const adapter = await c.createOlmAdapter({
        userId: c.userIdFor(me.username), deviceId: deviceIdFor(me.username),
        transport: c.createBackendTransport(http), storeName: `e2ee-${me.username}`,
      });
      await adapter.sync();
      await adapter.replenishPrekeys((await chatApi.prekeyCount()).oneTimePrekeyCount);
      const verifier = c.createPeerVerifier({ adapter, http, store: peers });
      return { c, adapter, verifier };
    })();
    ctx.catch(() => { ctx = null; });
    return ctx;
  }

  const peerOf = (conv: ConversationWire) => conv.members.find((m) => m.id !== me.id) ?? conv.members[0]!;

  async function refreshStale() {
    const { c, verifier } = await init();
    note(await verifier.refreshStale([...convos.values()].map((v) => c.userIdFor(peerOf(v).username))));
  }

  return {
    id: "live",
    async listConversations(): Promise<ConversationView[]> {
      await init();
      const { conversations } = await chatApi.listConversations();
      conversations.forEach((v) => convos.set(v.id, v));
      void refreshStale().catch(() => undefined);
      return conversations.map((v) => ({ id: v.id, name: peerOf(v).username, preview: "Encrypted message", lastActivityAt: v.createdAt ?? "", unread: 0 }));
    },
    async listMessages(conversationId) {
      const { adapter, verifier } = await init();
      const wire = [];
      let after: string | undefined;
      for (let i = 0; i < 20; i++) {
        const page = await chatApi.listMessages(conversationId, after);
        wire.push(...page.messages);
        if (!page.hasMore || !page.nextCursor) break;
        after = page.nextCursor;
      }
      const out: MessageView[] = [];
      const pending = [];
      for (const m of wire) {
        const cached = await texts.get(m.id);
        if (cached !== undefined || m.senderId === me.id) {
          out.push({ id: m.id, clientId: m.clientMsgId, fromMe: m.senderId === me.id, text: cached ?? "Sent from another session", sentAt: m.createdAt, status: "sent" });
        } else pending.push(m);
      }
      if (pending.length) {
        const { decodeMessage } = (await init()).c;
        const results: ReceiveResult[] = [];
        for (const m of pending) {
          let r: ReceiveResult;
          try { r = (await adapter.receive([decodeMessage(m)]))[0]!; } catch { r = { ok: false } as unknown as ReceiveResult; }
          results.push(r);
          if (r.ok) await texts.set(m.id, r.plaintext);
          out.push({ id: m.id, fromMe: false, text: r.ok ? r.plaintext : "Unable to decrypt this message", sentAt: m.createdAt, status: "delivered" });
        }
        note(await verifier.onReceiveResults(results.filter((r) => "envelope" in r || r.ok)));
        await chatApi.ack(pending.map((m) => m.id)).catch(() => undefined);
      }
      return out.sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    },
    async sendMessage(conversationId, text, clientId) {
      const { c, adapter } = await init();
      const conv = convos.get(conversationId);
      if (!conv) throw new Error("unknown conversation");
      const peerId = c.userIdFor(peerOf(conv).username);
      if (changed.has(peerId)) throw new IdentityChangedError(peerId);
      let devs = await adapter.peerIdentities(peerId);
      if (!devs.length) devs = await adapter.refreshPeer(peerId);
      if (!devs.length) throw new Error("peer has no keys");
      const env = await adapter.encrypt({ userId: peerId, deviceId: devs[0]!.deviceId }, text);
      const { message } = await chatApi.sendMessage(conversationId, c.encodeMessage(env, clientId));
      await texts.set(message.id, text);
      return { id: message.id, clientId, fromMe: true, text, sentAt: message.createdAt, status: "sent" };
    },
    async safety(conversationId): Promise<SafetyInfo> {
      const { c, adapter } = await init();
      const conv = convos.get(conversationId);
      if (!conv) return { digits: null, changed: false };
      const peerId = c.userIdFor(peerOf(conv).username);
      const pending = changed.get(peerId);
      const peer = pending ?? (await peers.get(peerId))?.identity ?? (await adapter.peerIdentities(peerId))[0];
      const digits = peer ? c.formatSafetyNumber(await c.safetyNumber(adapter.identity(), peer)) : null;
      return { digits, changed: !!pending };
    },
    async acceptNewIdentity(conversationId) {
      const { c, verifier } = await init();
      const conv = convos.get(conversationId);
      if (!conv) return;
      const peerId = c.userIdFor(peerOf(conv).username);
      const id = changed.get(peerId);
      if (id) { await verifier.acceptNewIdentity(id); changed.delete(peerId); }
    },
  };
}
