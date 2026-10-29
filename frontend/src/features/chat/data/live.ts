// Live adapter: Phase 1 backend (#13/#19) + packages/crypto (#16/#20). The frontend does
// no key mapping: it only calls the crypto package's adapter/bridge and the HTTP API.
// WASM loads client-side via dynamic import; keys live in IndexedDB (crypto package).
import type { BackendHttp, CryptoAdapter, DeviceIdentity, OlmAdapterOptions, PeerIdentityStore, ReceiveResult, StoredPeer } from "@e2ee/crypto";
type Crypto = typeof import("@e2ee/crypto");
import { chatApi } from "./http";
import { idbKv } from "./idb";
import type { HistoryStore } from "./history";
import { AttachmentError, browserDeps, decodeAttachmentMessage, encodeAttachmentMessage, openAttachment as openAtt, sendAttachment as sendAtt } from "../attachments/flow";
import { closeLocalE2EE, onWipe, storeNameFor } from "./wipe";
import { IdentityChangedError, NewDeviceRequiredError, type ChatAdapter, type DeviceState, type IdentityChangeKind, type PeerIdentityChange, type ConversationView, type MessageView, type SafetyInfo } from "./types";
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
      // Session expired: close stores; keys stay so re-login resumes this device.
      await closeLocalE2EE().catch(() => undefined);
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

/**
 * Run tasks one at a time per key. listMessages for a conversation must never overlap: the initial load and
 * the 4s poll would otherwise both fetch the same undelivered messages and decrypt them twice. The second
 * decrypt fails (ratchet keys are single-use), producing "Unable to decrypt" bubbles and out-of-order views.
 */
export function keyedSerial() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(task, task);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return run;
  };
}

/** E2EE-79: opening the adapter (which publishes keys) is only allowed for fresh/existing devices or after explicit confirmation. */
export function assertMayOpen(state: DeviceState, confirmed: boolean): void {
  if (state === "needs-new-device-confirmation" && !confirmed) throw new NewDeviceRequiredError();
}

export function liveAdapter(me: Me, injected?: HistoryStore): ChatAdapter {
  const serial = keyedSerial();
  const threads = new Map<string, { entries: Map<string, { seq: bigint; view: MessageView }> }>();
  const peers = idbKv<StoredPeer>(`${storeNameFor(me.id)}-peers`);
  const convos = new Map<string, ConversationWire>();
  const changed = new Map<string, DeviceIdentity>(); // peer userId -> new published identity
  let ctx: Promise<{ c: typeof import("@e2ee/crypto"); adapter: CryptoAdapter; verifier: ReturnType<typeof import("@e2ee/crypto").createPeerVerifier>; texts: HistoryStore }> | null = null;

  const note = (rs: readonly { userId: string; status: string; current?: DeviceIdentity }[]) => {
    for (const r of rs) if (r.status === "changed" && r.current) changed.set(r.userId, r.current);
  };

  let confirmedNewDevice = false;
  let state: Promise<DeviceState> | null = null;
  async function deviceState(): Promise<DeviceState> {
    state ??= import("@e2ee/crypto").then((c) => c.localDeviceState({ http, username: me.username, storeName: storeNameFor(me.id), deviceId: localStorage.getItem(`e2ee.deviceId.${me.id}`) ?? undefined }));
    state.catch(() => { state = null; });
    return state;
  }

  async function changeKind(peerId: string): Promise<IdentityChangeKind | undefined> {
    const s = await peers.get(peerId);
    const cur = changed.get(peerId) ?? s?.pendingChange;
    if (!cur) return undefined;
    const c = await import("@e2ee/crypto");
    return c.classifyIdentityChange(s?.identity, cur);
  }

  function init() {
    ctx ??= (async () => {
      const c = await import("@e2ee/crypto");
      assertMayOpen(await deviceState(), confirmedNewDevice);
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

  async function sendPlain(conversationId: string, text: string, clientId: string, attachmentRefs?: string[]): Promise<MessageView> {
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
      const { message } = await chatApi.sendMessage(conversationId, { ...c.encodeMessage(env, clientId), ...(attachmentRefs?.length ? { attachmentRefs } : {}) })
        .catch((e: unknown) => {
          if ((e as { code?: string }).code === "invalid_attachment_refs") throw new AttachmentError("server", "The attachment upload didn’t finish. Please attach the file again.", false);
          throw e;
        });
      await texts.put(conversationId, message.seq, { id: message.id, senderUserId: c.userIdFor(me.username), senderDeviceId: deviceIdFor(me.id), text, sentAt: message.createdAt, clientMsgId: clientId }).catch(() => undefined);
      const view: MessageView = { id: message.id, clientId, fromMe: true, ...plaintextView(text, c.toDisplayText), sentAt: message.createdAt, status: "sent" };
      threads.get(conversationId)?.entries.set(message.id, { seq: BigInt(message.seq), view });
      return view;
    }

  let display: (t: string) => string = (t) => t;

  /**
   * The server deletes messages once acked (PR #43), so the thread is rebuilt from the encrypted local
   * historyStore; the server only supplies not-yet-acked messages, which are decrypted -> persisted -> acked once.
   * Messages already in local history are never decrypted or acked again. Order is by server seq.
   */
  async function listMessagesNow(conversationId: string): Promise<MessageView[]> {
    const { c, adapter, verifier, texts } = await init();
    const myUserId = c.userIdFor(me.username);
    const thread = threads.get(conversationId) ?? { entries: new Map<string, { seq: bigint; view: MessageView }>() };
    threads.set(conversationId, thread);
    const add = (seq: string, view: MessageView) => { if (!thread.entries.has(view.id)) thread.entries.set(view.id, { seq: BigInt(seq), view }); };
    const local = await texts.list(conversationId, undefined, 100_000);
    const known = new Set(local.map((e) => e.id));
    for (const e of local) {
      const fromMe = e.senderUserId === myUserId;
      add(e.seq, { id: e.id, ...(e.clientMsgId ? { clientId: e.clientMsgId } : {}), fromMe, ...plaintextView(e.text, c.toDisplayText), sentAt: e.sentAt, status: fromMe ? "sent" : "delivered" });
    }
    const wire: MessageWire[] = [];
    let after: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await chatApi.listMessages(conversationId, after);
      wire.push(...page.messages);
      if (!page.hasMore || !page.nextCursor) break;
      after = page.nextCursor;
    }
    const pending: MessageWire[] = [];
    for (const m of wire) {
      if (known.has(m.id) || thread.entries.has(m.id)) continue; // already decrypted+persisted: never re-processed
      if (m.senderId === me.id) add(m.seq, { id: m.id, clientId: m.clientMsgId, fromMe: true, text: "Sent from another session", sentAt: m.createdAt, status: "sent" });
      else pending.push(m);
    }
    if (pending.length) {
      const seqOf = new Map(pending.map((m) => [m.id, m.seq]));
      const results = await processIncoming(pending, {
        receive: async (m) => (await adapter.receive([c.decodeMessage(m)]))[0]!, display: c.toDisplayText,
        history: { put: (cid, seq, msg) => texts.put(cid, seq, msg) }, ack: (ids) => chatApi.ack(ids).then(() => undefined),
        onView: (v) => add(seqOf.get(v.id)!, v),
      });
      note(await verifier.onReceiveResults(results));
    }
    return [...thread.entries.values()].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0)).map((e) => e.view);
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
    listMessages(conversationId) {
      return serial(conversationId, () => listMessagesNow(conversationId));
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
      return sendPlain(conversationId, encodeAttachmentMessage(desc), clientId, desc.ref ? [desc.ref] : undefined);
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
      return pending ? { digits, changed: true, changeKind: await changeKind(peerId) } : { digits, changed: false };
    },
    async acceptNewIdentity(conversationId) {
      const { c, verifier } = await init();
      const conv = convos.get(conversationId);
      if (!conv) return;
      const peerId = c.userIdFor(peerOf(conv).username);
      const id = changed.get(peerId) ?? (await peers.get(peerId))?.pendingChange;
      if (id) { await verifier.acceptNewIdentity(id); changed.delete(peerId); }
    },
    deviceState,
    async confirmNewDevice() {
      confirmedNewDevice = true;
      ctx = null;
      await init();
      state = Promise.resolve("existing");
    },
    async peerChange(conversationId): Promise<PeerIdentityChange | null> {
      const { c } = await init();
      const conv = convos.get(conversationId);
      if (!conv) return null;
      const peerId = c.userIdFor(peerOf(conv).username);
      const kind = await changeKind(peerId);
      return kind ? { peerId, username: peerOf(conv).username, kind } : null;
    },
  };
}
