// Live adapter: Phase 1 backend (#13/#19) + packages/crypto (#16/#20). The frontend does
// no key mapping: it only calls the crypto package's adapter/bridge and the HTTP API.
// WASM loads client-side via dynamic import; keys live in IndexedDB (crypto package).
import type { BackendHttp, CryptoAdapter, DeviceIdentity, OlmAdapterOptions, PeerIdentityStore, ReceiveResult, StoredPeer } from "@e2ee/crypto";
type Crypto = typeof import("@e2ee/crypto");
import { chatApi } from "./http";
import { idbKv } from "./idb";
import type { HistoryStore } from "./history";
import { browserDeps, decodeAttachmentMessage, encodeAttachmentMessage, openAttachment as openAtt, sendAttachment as sendAtt } from "../attachments/flow";
import { onWipe, storeNameFor, wipeLocalE2EE } from "./wipe";
import { IdentityChangedError, type ChatAdapter, type ConversationView, type MessageView, type SafetyInfo } from "./types";
import type { ConversationWire, MessageWire } from "@e2ee/shared";

export interface Me { id: string; username: string }

const http: BackendHttp = {
  async request(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method, credentials: "same-origin", cache: "no-store",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const json: unknown = await res.json().catch(() => null);
    if (res.status === 401) {
      // Session expired: wipe local key stores before leaving.
      await wipeLocalE2EE();
      await fetch("/session/expired", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
      window.location.replace("/login");
    }
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body: json });
    return json;
  },
};

function deviceIdFor(userId: string): string {
  const k = `e2ee.deviceId.${userId}`;
  let id = localStorage.getItem(k);
  if (!id) { id = crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase(); localStorage.setItem(k, id); }
  return id;
}

/** Adapter options. identityGate (wrapped with withRevocationCheck, fail-closed) is REQUIRED here (optional in the library): encrypt must refuse unverified identity changes. */
export function olmOptions(c: Pick<Crypto, "userIdFor" | "createBackendTransport" | "createIdentityGate" | "withRevocationCheck">, me: Me, deviceId: string, peers: PeerIdentityStore, transportHttp: BackendHttp = http): OlmAdapterOptions & { identityGate: NonNullable<OlmAdapterOptions["identityGate"]> } {
  return {
    userId: c.userIdFor(me.username), deviceId,
    transport: c.createBackendTransport(transportHttp), storeName: storeNameFor(me.id),
    identityGate: c.withRevocationCheck(c.createIdentityGate(peers), { http: transportHttp, store: peers }),
  };
}

/** Plaintext -> view fields. Attachment messages carry an (untrusted, re-validated on open) descriptor. */
export function plaintextView(pt: string, display: (t: string) => string): { text: string; attachment?: unknown } {
  const a = decodeAttachmentMessage(pt);
  return a !== null ? { text: "Attachment", attachment: a } : { text: display(pt) };
}

/** File names must satisfy the descriptor rules (1–255 chars, no control chars / path separators). */
export function safeFileName(n: string): string {
  const s = n.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 255);
  return s || "file";
}

/** decrypt -> persist (awaited) -> ack. A message is acked only after its plaintext is stored. */
export async function processIncoming(
  pending: readonly MessageWire[],
  d: { receive(m: MessageWire): Promise<ReceiveResult>; history: Pick<HistoryStore, "put">; ack(ids: string[]): Promise<void>; onView(v: MessageView): void; display(t: string): string },
): Promise<ReceiveResult[]> {
  const results: ReceiveResult[] = [];
  const persisted: string[] = [];
  for (const m of pending) {
    let r: ReceiveResult | null = null;
    try { r = await d.receive(m); } catch { r = null; }
    if (r) results.push(r);
    if (r?.ok) {
      try {
        await d.history.put(m.conversationId, m.seq, { id: m.id, senderUserId: r.sender.userId, senderDeviceId: r.sender.deviceId, text: r.plaintext, sentAt: m.createdAt, clientMsgId: m.clientMsgId });
        persisted.push(m.id);
      } catch { /* not persisted -> not acked; redelivered later */ }
    }
    d.onView({ id: m.id, fromMe: false, ...(r?.ok ? plaintextView(r.plaintext, d.display) : { text: "Unable to decrypt this message" }), sentAt: m.createdAt, status: "delivered" });
  }
  if (persisted.length) await d.ack(persisted).catch(() => undefined);
  return results;
}

export function liveAdapter(me: Me, injected?: HistoryStore): ChatAdapter {
  const threads = new Map<string, { after?: string; views: MessageView[]; cache?: Map<string, string> }>();
  const peers = idbKv<StoredPeer>(`${storeNameFor(me.id)}-peers`);
  const convos = new Map<string, ConversationWire>();
  const changed = new Map<string, DeviceIdentity>(); // peer userId -> new published identity
  let ctx: Promise<{ c: typeof import("@e2ee/crypto"); adapter: CryptoAdapter; verifier: ReturnType<typeof import("@e2ee/crypto").createPeerVerifier>; texts: HistoryStore }> | null = null;

  const note = (rs: readonly { userId: string; status: string; current?: DeviceIdentity }[]) => {
    for (const r of rs) if (r.status === "changed" && r.current) changed.set(r.userId, r.current);
  };

  function init() {
    ctx ??= (async () => {
      const c = await import("@e2ee/crypto");
      const adapter = await c.createOlmAdapter(olmOptions(c, me, deviceIdFor(me.id), peers));
      await adapter.sync();
      await adapter.replenishPrekeys((await chatApi.prekeyCount()).oneTimePrekeyCount);
      const verifier = c.createPeerVerifier({ adapter, http, store: peers });
      display = c.toDisplayText;
      const texts = injected ?? (await c.openHistoryStore(storeNameFor(me.id)));
      onWipe(() => texts.close());
      return { c, adapter, verifier, texts };
    })();
    ctx.catch(() => { ctx = null; });
    return ctx;
  }

  const peerOf = (conv: ConversationWire) => conv.members.find((m) => m.id !== me.id) ?? conv.members[0]!;

  async function refreshStale() {
    const { c, verifier } = await init();
    note(await verifier.refreshStale([...convos.values()].map((v) => c.userIdFor(peerOf(v).username))));
  }

  async function sendPlain(conversationId: string, text: string, clientId: string): Promise<MessageView> {
      const { c, adapter, texts } = await init();
      const conv = convos.get(conversationId);
      if (!conv) throw new Error("unknown conversation");
      const peerId = c.userIdFor(peerOf(conv).username);
      if (changed.has(peerId) || (await peers.get(peerId))?.pendingChange) throw new IdentityChangedError(peerId);
      let devs = await adapter.peerIdentities(peerId);
      if (!devs.length) devs = await adapter.refreshPeer(peerId);
      if (!devs.length) throw new Error("peer has no keys");
      let env;
      try {
        env = await adapter.encrypt({ userId: peerId, deviceId: devs[0]!.deviceId }, text);
      } catch (e) {
        if ((e as { code?: string }).code === "IDENTITY_CHANGED") {
          const cur = (await adapter.refreshPeer(peerId))[0] ?? devs[0]!;
          changed.set(peerId, cur);
          throw new IdentityChangedError(peerId);
        }
        throw e;
      }
      const { message } = await chatApi.sendMessage(conversationId, c.encodeMessage(env, clientId));
      await texts.put(conversationId, message.seq, { id: message.id, senderUserId: c.userIdFor(me.username), senderDeviceId: deviceIdFor(me.id), text, sentAt: message.createdAt, clientMsgId: clientId }).catch(() => undefined);
      threads.get(conversationId)?.cache?.set(message.id, text);
      return { id: message.id, clientId, fromMe: true, ...plaintextView(text, c.toDisplayText), sentAt: message.createdAt, status: "sent" };
    }

  let display: (t: string) => string = (t) => t;

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
      const { c, adapter, verifier, texts } = await init();
      const thread = threads.get(conversationId) ?? { views: [] };
      threads.set(conversationId, thread);
      const wire = [];
      let after = thread.after;
      for (let i = 0; i < 20; i++) {
        const page = await chatApi.listMessages(conversationId, after);
        wire.push(...page.messages);
        if (page.nextCursor) after = page.nextCursor;
        if (!page.hasMore || !page.nextCursor) break;
      }
      const last = wire.at(-1);
      thread.after = last ? last.seq : after;
      const out: MessageView[] = [];
      if (!thread.cache) thread.cache = new Map((await texts.list(conversationId)).map((e) => [e.id, e.text]));
      const cache = thread.cache;
      const pending = [];
      for (const m of wire) {
        const cached = cache.get(m.id);
        if (cached !== undefined || m.senderId === me.id) {
          out.push({ id: m.id, clientId: m.clientMsgId, fromMe: m.senderId === me.id, ...(cached !== undefined ? plaintextView(cached, c.toDisplayText) : { text: "Sent from another session" }), sentAt: m.createdAt, status: "sent" });
        } else pending.push(m);
      }
      if (pending.length) {
        const results = await processIncoming(pending, {
          receive: async (m) => (await adapter.receive([c.decodeMessage(m)]))[0]!, display: c.toDisplayText,
          history: { put: async (cid, seq, msg) => { await texts.put(cid, seq, msg); cache.set(msg.id, msg.text); } }, ack: (ids) => chatApi.ack(ids).then(() => undefined),
          onView: (v) => out.push(v),
        });
        note(await verifier.onReceiveResults(results));
      }
      const seen = new Set(thread.views.map((v) => v.id));
      thread.views = [...thread.views, ...out.filter((v) => !seen.has(v.id))].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
      return thread.views;
    },
    async createConversation(username) {
      const { conversation: v } = await chatApi.createConversation(username.trim().replace(/^@/, ""));
      convos.set(v.id, v);
      return { id: v.id, name: peerOf(v).username, preview: "", lastActivityAt: v.createdAt ?? new Date().toISOString(), unread: 0 };
    },
    async sendMessage(conversationId, text, clientId) {
      return sendPlain(conversationId, text, clientId);
    },
    async sendAttachment(conversationId, file, clientId, onPhase) {
      const { c } = await init();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const desc = await sendAtt(conversationId, bytes, { name: safeFileName(file.name), mime: /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : "application/octet-stream" }, browserDeps(c), onPhase);
      return sendPlain(conversationId, encodeAttachmentMessage(desc), clientId);
    },
    async openAttachment(descriptor, onPhase) {
      const { c } = await init();
      const r = await openAtt(descriptor, browserDeps(c), onPhase);
      return { bytes: r.bytes, name: r.descriptor.name, mime: r.descriptor.mime };
    },
    displayText: (t) => display(t),
        async safety(conversationId): Promise<SafetyInfo> {
      const { c, adapter } = await init();
      const conv = convos.get(conversationId);
      if (!conv) return { digits: null, changed: false };
      const peerId = c.userIdFor(peerOf(conv).username);
      const pending = changed.get(peerId) ?? (await peers.get(peerId))?.pendingChange;
      const peer = pending ?? (await peers.get(peerId))?.identity ?? (await adapter.peerIdentities(peerId))[0];
      const digits = peer ? c.formatSafetyNumber(await c.safetyNumber(adapter.identity(), peer)) : null;
      return { digits, changed: !!pending };
    },
    async acceptNewIdentity(conversationId) {
      const { c, verifier } = await init();
      const conv = convos.get(conversationId);
      if (!conv) return;
      const peerId = c.userIdFor(peerOf(conv).username);
      const id = changed.get(peerId) ?? (await peers.get(peerId))?.pendingChange;
      if (id) { await verifier.acceptNewIdentity(id); changed.delete(peerId); }
    },
  };
}
