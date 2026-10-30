import { assertSameAccount } from "@/lib/session-guard";
// Live adapter: Phase 1 backend (#13/#19) + packages/crypto (#16/#20). The frontend does
// no key mapping: it only calls the crypto package's adapter/bridge and the HTTP API.
// WASM loads client-side via dynamic import; keys live in IndexedDB (crypto package).
import { noteKeySource, withBadge } from "./keySource";
import type { BackendHttp, CryptoAdapter, DeviceIdentity, OlmAdapterOptions, PeerIdentityStore, ReceiveResult, StoredPeer } from "@e2ee/crypto";
type Crypto = typeof import("@e2ee/crypto");
import { chatApi } from "./http";
import { idbKv } from "./idb";
import type { HistoryStore } from "./history";
import { AttachmentError, browserDeps, decodeAttachmentMessage, encodeAttachmentMessage, openAttachment as openAtt, sendAttachment as sendAtt } from "../attachments/flow";
import { closeLocalE2EE, onWipe, storeNameFor } from "./wipe";
import { endSession, onSessionEnd } from "@/lib/session-guard";
import { systemLine } from "../groupCopy";
import { IdentityChangedError, NewDeviceRequiredError, type ChatAdapter, type DeviceState, type IdentityChangeKind, type PeerIdentityChange, type ConversationView, type GroupInfo, type MessageView, type SafetyInfo } from "./types";
import { messageSchema, systemEventSchema, toDeviceListSchema, undeliverableListSchema, type ConversationWire, type MessageWire, type SystemEventWire } from "@e2ee/shared";

export interface Me { id: string; username: string }

/** Local-history marker for server membership events (they carry no ciphertext). */
export const SYSTEM_PREFIX = "\u0000e2ee.system:";
/** Group name travels inside the group as an E2EE Megolm message; the server never sees it. */
export const GROUP_META_TYPE = "org.e2ee.group.meta";
export function encodeGroupMeta(name: string): string { return JSON.stringify({ t: GROUP_META_TYPE, name: name.slice(0, 64) }); }
export function decodeGroupMeta(pt: string): { name: string } | null {
  if (!pt.startsWith("{\"t\":\"" + GROUP_META_TYPE)) return null;
  try { const o = JSON.parse(pt) as { t?: unknown; name?: unknown }; return o.t === GROUP_META_TYPE && typeof o.name === "string" ? { name: o.name } : null; } catch { return null; }
}
/** Acks for one receive batch: everything persisted, in seq order, up to (not including) the first failure. */
export function ackPrefix(results: readonly { id: string; ok: boolean }[]): string[] {
  const out: string[] = [];
  for (const r of results) { if (!r.ok) break; out.push(r.id); }
  return out;
}

const http: BackendHttp = {
  async request(method, path, body) {
    assertSameAccount();
    const res = await fetch(`/api${path}`, {
      method, credentials: "same-origin", cache: "no-store",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const json: unknown = await res.json().catch(() => null);
    if (res.status === 401) {
      endSession(); // stop poll/resender/adapter before closing stores
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
  d: { receive(m: MessageWire): Promise<ReceiveResult>; history: Pick<HistoryStore, "put">; ack(ids: string[]): Promise<void>; onView(v: MessageView): void; display(t: string): string; failedText?(r: ReceiveResult | null): string },
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
    d.onView({ id: m.id, fromMe: false, ...(r?.ok ? plaintextView(r.plaintext, d.display) : { text: d.failedText?.(r) ?? "Unable to decrypt this message" }), sentAt: m.createdAt, status: "delivered" });
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
  // Per open thread: decrypted views, plus (after the first load) `after` = highest seq such that everything at or below it
// is settled, so a wake only fetches newer messages. Never advanced past a message we couldn't decrypt yet.
type Thread = { entries: Map<string, { seq: bigint; view: MessageView }>; loaded?: boolean; after?: bigint; hidden?: Set<string> };
  const threads = new Map<string, Thread>();
  const peers = idbKv<StoredPeer>(`${storeNameFor(me.id)}-peers`);
  const convos = new Map<string, ConversationWire>();
  const changed = new Map<string, DeviceIdentity>(); // peer userId -> new published identity
  let ctx: Promise<{ c: typeof import("@e2ee/crypto"); adapter: CryptoAdapter & import("@e2ee/crypto").GroupPrimitives; verifier: ReturnType<typeof import("@e2ee/crypto").createPeerVerifier>; texts: HistoryStore }> | null = null;

  const note = (rs: readonly { userId: string; status: string; current?: DeviceIdentity }[]) => {
    for (const r of rs) if (r.status === "changed" && r.current) changed.set(r.userId, r.current);
  };

  let cryptoMod: typeof import("@e2ee/crypto") | null = null;
  let confirmedNewDevice = false;
  let state: Promise<DeviceState> | null = null;
  async function deviceState(): Promise<DeviceState> {
    // /keys/identity is rate-limited; a 429 here must not fail the whole chat list, so retry a few times.
    const check = async (c: typeof import("@e2ee/crypto"), tries = 3): Promise<DeviceState> => {
      try { return await c.localDeviceState({ http, username: me.username, storeName: storeNameFor(me.id), deviceId: localStorage.getItem(`e2ee.deviceId.${me.id}`) ?? undefined }); }
      catch (e) {
        if (tries <= 1 || (e as { cause?: { status?: number } }).cause?.status !== 429) throw e;
        await new Promise((r) => setTimeout(r, 5000));
        return check(c, tries - 1);
      }
    };
    state ??= import("@e2ee/crypto").then((c) => check(c));
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
      cryptoMod = c;
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

  const usernameById = new Map<string, string>();
  const remember = (v: ConversationWire) => { convos.set(v.id, v); for (const m of v.members) usernameById.set(m.id, m.username); };
  // Group names live only in the AES-GCM history store (pseudo-conversation per group), cached in memory.
  const legacyNamePrefix = `e2ee.groupName.${me.id}.`;
  const nameConv = (gid: string) => `__groupname__:${gid}`;
  const names = new Map<string, string>();
  async function saveName(gid: string, name: string) {
    names.set(gid, name);
    const { texts } = await init();
    await texts.put(nameConv(gid), BigInt(Date.now()), { id: `name-${gid}`, senderUserId: "local", senderDeviceId: "local", text: name, sentAt: new Date().toISOString() }).catch(() => undefined);
  }
  let migrated = false;
  onWipe(() => { names.clear(); for (const k of Object.keys(localStorage)) if ((k.startsWith("e2ee.groupName.") || k.startsWith("e2ee.keySource."))) localStorage.removeItem(k); });
  async function loadNames(groups: ConversationWire[]) {
    const { texts } = await init();
    if (!migrated) {
      migrated = true;
      for (const k of Object.keys(localStorage)) {
        if (!k.startsWith("e2ee.groupName.")) continue;
        const v = localStorage.getItem(k);
        if (k.startsWith(legacyNamePrefix) && v) await saveName(k.slice(legacyNamePrefix.length), v);
        localStorage.removeItem(k); // never keep plaintext names around
      }
    }
    for (const g of groups) {
      if (names.has(g.id)) continue;
      const last = (await texts.list(nameConv(g.id), undefined, 100_000).catch(() => [])).at(-1);
      if (last) names.set(g.id, last.text);
    }
  }
  const groupName = (v: ConversationWire) => names.get(v.id) || v.members.filter((m) => m.id !== me.id).map((m) => m.username).join(", ") || "Group";
  const toView = (v: ConversationWire): ConversationView => v.kind === "group"
    ? { id: v.id, kind: "group", name: groupName(v), preview: "Encrypted message", lastActivityAt: v.createdAt ?? "", unread: 0 }
    : { id: v.id, kind: "direct", name: peerOf(v).username, preview: "Encrypted message", lastActivityAt: v.createdAt ?? "", unread: 0 };
  const identityCheckedAt = new Map<string, number>(); // groupId -> last member identity re-check
  const inflight = new Set<string>(); // clientMsgIds this tab is sending right now
  const groupPending = new Map<string, string[]>(); // groupId -> member userIds (crypto ids) whose safety number is unaccepted
  let gcInst: import("@e2ee/crypto").GroupCrypto | null = null;
  let gcCtx: unknown = null;
  async function gc() {
    const { c, adapter, texts } = await init();
    if (!gcInst || gcCtx !== ctx) {
      gcCtx = ctx;
      const state = await c.openGroupStateStore(`${storeNameFor(me.id)}-groups`);
      onWipe(() => state.close());
      gcInst = c.createGroupCrypto({ adapter, state, backend: c.createHttpGroupBackend(http), history: texts, peers, senderUsername: (id) => usernameById.get(id), ownerUserId: c.userIdFor(me.username), storeName: storeNameFor(me.id) });
    }
    return gcInst;
  }
  async function refreshConvos() {
    const { conversations } = await chatApi.listConversations();
    const seen = new Set(conversations.map((v) => v.id));
    for (const id of [...convos.keys()]) if (!seen.has(id)) convos.delete(id);
    conversations.forEach(remember);
    await loadNames(conversations.filter((v) => v.kind === "group")).catch(() => undefined);
    return conversations;
  }
  /** Pull Olm to-device envelopes (Megolm room keys, key requests/responses), process, then ack. Returns groups to retry. */
  const pullToDevice = () => serial("\u0000to-device", async () => {
    const { c } = await init();
    const g = await gc();
    const retry = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const page = toDeviceListSchema.parse(await http.request("GET", "/to-device?limit=100"));
      if (!page.messages.length) break;
      const envs = [];
      for (const m of page.messages) { try { envs.push(c.decodeToDevice(m)); } catch { /* malformed: drop */ } }
      const r = await g.receiveToDevice(envs);
      r.retry.forEach((x) => retry.add(x));
      await http.request("POST", "/to-device/ack", { ids: page.messages.map((m) => m.id) });
      if (!page.hasMore) break;
    }
    return retry;
  });
  async function sendGroupMeta(gid: string, name: string) {
    const { c, texts } = await init();
    const pt = encodeGroupMeta(name);
    const clientId = crypto.randomUUID();
    inflight.add(clientId);
    const r = await (await gc()).send(gid, pt, clientId).finally(() => setTimeout(() => inflight.delete(clientId), 5000));
    const m = messageSchema.safeParse((r.message as { message?: unknown })?.message);
    if (m.success) await texts.put(gid, m.data.seq, { id: m.data.id, senderUserId: c.userIdFor(me.username), senderDeviceId: deviceIdFor(me.id), text: pt, sentAt: m.data.createdAt, clientMsgId: clientId }).catch(() => undefined);
    groupPending.set(gid, r.pending);
  }
  const groupInfoOf = (v: ConversationWire): GroupInfo => ({ id: v.id, name: groupName(v), adminId: v.adminId ?? null, members: v.members.map((m) => ({ id: m.id, username: m.username })), membershipVersion: v.membershipVersion ?? 0 });

  const peerOf = (conv: ConversationWire) => conv.members.find((m) => m.id !== me.id) ?? conv.members[0]!;

  async function refreshStale() {
    const { c, verifier } = await init();
    note(await verifier.refreshStale([...convos.values()].filter((v) => v.kind !== "group").map((v) => c.userIdFor(peerOf(v).username))));
  }

  // Logout/expiry: drop this account's context, group crypto and resender so nothing queued can run under the next cookie.
  let disposed = false;
  onSessionEnd(() => { disposed = true; ctx = null; gcInst = null; gcCtx = null; resenderInst = null; ctxForResender = null; inflight.clear(); });
  const resentOnce = new Set<string>(); // clientMsgIds already re-sent by this tab: never re-send twice

  async function sendPlain(conversationId: string, text: string, clientId: string, attachmentRefs?: string[]): Promise<MessageView> {
    if (disposed) throw new Error("session ended");
      const { c, adapter, texts } = await init();
      const conv = convos.get(conversationId);
      if (!conv) throw new Error("unknown conversation");
      if (conv.kind === "group") return sendGroup(conversationId, text, clientId);
      const peerId = c.userIdFor(peerOf(conv).username);
      if (changed.has(peerId) || (await peers.get(peerId))?.pendingChange) throw new IdentityChangedError(peerId);
      let devs = await adapter.peerIdentities(peerId);
      // Encrypt to the accepted identity's device (after a device change the old one may still be listed).
      const trusted = (await peers.get(peerId))?.identity.deviceId;
      if (!devs.length || (trusted && !devs.some((d) => d.deviceId === trusted))) devs = await adapter.refreshPeer(peerId);
      devs = [...devs].sort((a, b) => Number(b.deviceId === trusted) - Number(a.deviceId === trusted));
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

  async function sendGroup(gid: string, text: string, clientId: string): Promise<MessageView> {
    const { c, texts } = await init();
    let r;
    inflight.add(clientId);
    setTimeout(() => inflight.delete(clientId), 30_000);
    try { r = await (await gc()).send(gid, text, clientId); } catch (e) {
      if ((e as { status?: number }).status === 404 || (e as { status?: number }).status === 403) { convos.delete(gid); threads.delete(gid); await (await gc()).forget(gid).catch(() => undefined); }
      throw e;
    }
    groupPending.set(gid, r.pending);
    const message = messageSchema.parse((r.message as { message?: unknown })?.message);
    await texts.put(gid, message.seq, { id: message.id, senderUserId: c.userIdFor(me.username), senderDeviceId: deviceIdFor(me.id), text, sentAt: message.createdAt, clientMsgId: clientId }).catch(() => undefined);
    const view: MessageView = { id: message.id, clientId, fromMe: true, ...plaintextView(text, c.toDisplayText), sentAt: message.createdAt, status: "sent" };
    threads.get(gid)?.entries.set(message.id, { seq: BigInt(message.seq), view });
    return view;
  }

  /** Move the thread's fetch cursor to the newest fetched seq, but never past `unsettled` (kept for re-fetch). */
  function advance(thread: Thread, wire: MessageWire[], unsettled: bigint | undefined) {
    thread.loaded = true;
    let top = thread.after ?? 0n;
    for (const m of wire) { const b = BigInt(m.seq); if (b > top) top = b; }
    if (unsettled !== undefined && unsettled - 1n < top) top = unsettled - 1n;
    if (thread.after === undefined || top > thread.after || unsettled !== undefined) thread.after = top < 0n ? 0n : top;
  }

  async function listGroupMessagesNow(gid: string): Promise<MessageView[]> {
    const { c, texts, verifier } = await init();
    const g = await gc();
    const myUserId = c.userIdFor(me.username);
    const thread: Thread = threads.get(gid) ?? { entries: new Map<string, { seq: bigint; view: MessageView }>() };
    threads.set(gid, thread);
    const add = (seq: string, view: MessageView) => { if (!thread.entries.has(view.id) || thread.entries.get(view.id)!.view.status === "failed") thread.entries.set(view.id, { seq: BigInt(seq), view }); };
    const hidden = (thread.hidden ??= new Set<string>()); // decrypted in-group meta messages: known, not rendered
    const nameOf = (cryptoUserId: string) => { for (const u of usernameById.values()) if (c.userIdFor(u) === cryptoUserId) return u; return undefined; };
    const fromText = (id: string, seq: string, senderUserId: string, text: string, sentAt: string, clientMsgId?: string) => {
      if (text.startsWith(SYSTEM_PREFIX)) {
        const ev = systemEventSchema.safeParse(JSON.parse(text.slice(SYSTEM_PREFIX.length)) as unknown);
        if (ev.success) add(seq, { id, fromMe: false, system: true, text: systemLine(ev.data, me.id), sentAt, status: "delivered" });
        return;
      }
      const meta = decodeGroupMeta(text);
      if (meta) { if (names.get(gid) !== meta.name) void saveName(gid, meta.name); hidden.add(id); return; }
      const fromMe = senderUserId === myUserId;
      add(seq, { id, ...(clientMsgId ? { clientId: clientMsgId } : {}), fromMe, ...plaintextView(text, c.toDisplayText), sentAt, status: fromMe ? "sent" : "delivered", ...(fromMe ? {} : { senderName: nameOf(senderUserId) }) });
    };
    // keySource per message id (#81). Metadata only (no content), kept per account+group so the badge survives reloads.
    const ksKey = `e2ee.keySource.${me.id}.${gid}`;
    const forwarded = new Set<string>((() => { try { return JSON.parse(localStorage.getItem(ksKey) ?? "[]") as string[]; } catch { return []; } })());
    const ks0 = forwarded.size;
    let ksDirty = false;
    if (!thread.loaded) for (const e of await texts.list(gid, undefined, 100_000)) fromText(e.id, e.seq, e.senderUserId, e.text, e.sentAt, e.clientMsgId);
    await pullToDevice().catch(() => undefined);
    const wire: MessageWire[] = [];
    let after: string | undefined = thread.after !== undefined ? String(thread.after) : undefined;
    let unsettled: bigint | undefined; // lowest seq we must see again next time (undecryptable / still in flight)
    const hold = (seq: string) => { const b = BigInt(seq); if (unsettled === undefined || b < unsettled) unsettled = b; };
    for (let i = 0; i < 20; i++) {
      const page = await chatApi.listMessages(gid, after);
      wire.push(...page.messages);
      if (!page.hasMore || !page.nextCursor) break;
      after = page.nextCursor;
    }
    const known = new Set([...thread.entries.entries()].filter(([, e]) => e.view.status !== "failed").map(([id]) => id));
    const pending: MessageWire[] = [];
    for (const m of wire) {
      if (known.has(m.id) || hidden.has(m.id)) continue;
      // Own message not (yet) in local history: in flight from this tab -> skip; else decrypt it and only call it
      // "another session" if the envelope's device isn't this one.
      if (m.kind !== "system" && m.senderId === me.id && inflight.has(m.clientMsgId)) { hold(m.seq); continue; }
      pending.push(m);
    }
    if (pending.length) {
      const results = await g.receive(gid, pending as unknown as import("@e2ee/crypto").GroupMessageDto[]);
      const acks: { id: string; ok: boolean }[] = [];
      for (const r of results) {
        const m = r.dto as unknown as MessageWire;
        if (r.kind === "member_event") {
          const ev: SystemEventWire | undefined = m.event;
          if (ev) {
            const text = SYSTEM_PREFIX + JSON.stringify(ev);
            let ok = true;
            await texts.put(gid, m.seq, { id: m.id, senderUserId: "system", senderDeviceId: "system", text, sentAt: m.createdAt }).catch(() => { ok = false; });
            fromText(m.id, m.seq, "system", text, m.createdAt);
            acks.push({ id: m.id, ok });
          } else acks.push({ id: m.id, ok: true });
        } else if (r.ok && m.senderId === me.id && r.sender.deviceId !== deviceIdFor(me.id)) {
          add(m.seq, { id: m.id, clientId: m.clientMsgId, fromMe: true, text: "Sent from another session", sentAt: m.createdAt, status: "sent" });
          acks.push({ id: m.id, ok: true });
        } else if (r.ok) {
          if (m.senderId === me.id) await texts.put(gid, m.seq, { id: m.id, senderUserId: r.sender.userId, senderDeviceId: r.sender.deviceId, text: r.plaintext, sentAt: m.createdAt, clientMsgId: m.clientMsgId }).catch(() => undefined);
          const ks = (r as { keySource?: "sender" | "forwarded" }).keySource;
          if (noteKeySource(forwarded, m.id, ks)) ksDirty = true;
          fromText(m.id, m.seq, r.sender.userId, r.plaintext, m.createdAt, m.clientMsgId);
          acks.push({ id: m.id, ok: true });
        } else {
          if (m.senderId === me.id) { add(m.seq, { id: m.id, clientId: m.clientMsgId, fromMe: true, text: "Sent from another session", sentAt: m.createdAt, status: "sent" }); acks.push({ id: m.id, ok: true }); continue; }
          const su = usernameById.get(m.senderId);
          if (su) void verifier.refresh(c.userIdFor(su)).then((x) => note([x])).catch(() => undefined); // sender's device may have changed
          hold(m.seq);
          add(m.seq, { id: m.id, fromMe: false, text: r.code === "MISSING_ROOM_KEY" ? "Waiting for this message’s key from the sender…" : "Unable to decrypt this message", sentAt: m.createdAt, status: "failed", senderName: usernameById.get(m.senderId) });
          acks.push({ id: m.id, ok: false });
        }
      }
      const ids = ackPrefix(acks);
      if (ids.length) await chatApi.ack(ids).catch(() => undefined);
    }
    advance(thread, wire, unsettled);
    if (ksDirty || forwarded.size !== ks0) { try { localStorage.setItem(ksKey, JSON.stringify([...forwarded])); } catch { /* storage off */ } }
    for (const e of thread.entries.values()) {
      e.view = withBadge(e.view, forwarded);
    }
    return [...thread.entries.values()].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0)).map((e) => e.view);
  }

  /**
   * The server deletes messages once acked (PR #43), so the thread is rebuilt from the encrypted local
   * historyStore; the server only supplies not-yet-acked messages, which are decrypted -> persisted -> acked once.
   * Messages already in local history are never decrypted or acked again. Order is by server seq.
   */
  let resenderInst: ReturnType<typeof import("@e2ee/crypto").createResender> | null = null;
  let ctxForResender: unknown = null;
  function resender() {
    if (!resenderInst || ctxForResender !== ctx) {
      ctxForResender = ctx;
      resenderInst = cryptoMod!.createResender({
        parse: (r) => undeliverableListSchema.parse(r),
        http, history: { list: async (cid, after, limit) => (await init()).texts.list(cid, after, limit) }, selfUserId: cryptoMod!.userIdFor(me.username),
        send: async (cid, text, clientMsgId) => {
          // Re-send keeps the original clientMsgId and only once per tab; a delivered copy is never re-posted.
          if (resentOnce.has(clientMsgId)) return;
          await sendPlain(cid, text, clientMsgId);
          resentOnce.add(clientMsgId);
        },
      });
    }
    return resenderInst;
  }

  async function listMessagesNow(conversationId: string): Promise<MessageView[]> {
    if (!convos.has(conversationId)) await refreshConvos().catch(() => undefined);
    if (convos.get(conversationId)?.kind === "group") return listGroupMessagesNow(conversationId);
    const { c, adapter, verifier, texts } = await init();
    const myUserId = c.userIdFor(me.username);
    const thread: Thread = threads.get(conversationId) ?? { entries: new Map<string, { seq: bigint; view: MessageView }>() };
    threads.set(conversationId, thread);
    const add = (seq: string, view: MessageView) => { if (!thread.entries.has(view.id)) thread.entries.set(view.id, { seq: BigInt(seq), view }); };
    const local = thread.loaded ? [] : await texts.list(conversationId, undefined, 100_000);
    const known = new Set(local.map((e) => e.id));
    for (const e of local) {
      const fromMe = e.senderUserId === myUserId;
      add(e.seq, { id: e.id, ...(e.clientMsgId ? { clientId: e.clientMsgId } : {}), fromMe, ...plaintextView(e.text, c.toDisplayText), sentAt: e.sentAt, status: fromMe ? "sent" : "delivered" });
    }
    const wire: MessageWire[] = [];
    let after: string | undefined = thread.after !== undefined ? String(thread.after) : undefined;
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
        failedText: (r) => (r && !r.ok && c.isForPreviousDevice(r.envelope, adapter.identity()) ? c.PREVIOUS_DEVICE_TEXT : "Unable to decrypt this message"),
      });
      note(await verifier.onReceiveResults(results));
    }
    // 1:1 entries (incl. failed ones) are never re-processed, so every fetched message is settled.
    advance(thread, wire, undefined);
    // Own messages the server flagged undeliverable (recipient replaced its device): show as not delivered.
    const flagged = new Set((await resender().pendingResends(conversationId).catch(() => [])).map((p) => p.clientMsgId));
    for (const e of thread.entries.values()) {
      if (e.view.fromMe && e.view.clientId && flagged.has(e.view.clientId)) e.view = { ...e.view, status: "failed", undeliverable: "recipient-changed-device" };
      else if (e.view.undeliverable && e.view.clientId && !flagged.has(e.view.clientId)) e.view = { ...e.view, status: "sent", undeliverable: undefined };
    }
    return [...thread.entries.values()].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0)).map((e) => e.view);
  }

  return {
    id: "live",
    async listConversations(): Promise<ConversationView[]> {
      await init();
      const conversations = await refreshConvos();
      void refreshStale().catch(() => undefined);
      void pullToDevice().catch(() => undefined);
      return conversations.map(toView);
    },
    listMessages(conversationId) {
      return serial(conversationId, () => listMessagesNow(conversationId));
    },
    async createConversation(username) {
      const { conversation: v } = await chatApi.createConversation(username.trim().replace(/^@/, ""));
      remember(v);
      return { ...toView(v), preview: "", lastActivityAt: v.createdAt ?? new Date().toISOString() };
    },
    async createGroup(name, usernames) {
      await init();
      const { conversation: v } = await chatApi.createGroup(usernames.map((u) => u.trim().replace(/^@/, "")));
      remember(v);
      await saveName(v.id, name.trim().slice(0, 64));
      await sendGroupMeta(v.id, name.trim()).catch(() => undefined); // shares the first Megolm key too
      return { ...toView(v), preview: "", lastActivityAt: v.createdAt ?? new Date().toISOString() };
    },
    async groupInfo(gid) {
      await refreshConvos();
      const v = convos.get(gid);
      if (!v || v.kind !== "group") throw Object.assign(new Error("not a member"), { code: "not_member" });
      return groupInfoOf(v);
    },
    async addGroupMembers(gid, usernames) {
      const { conversation: v } = await chatApi.addGroupMembers(gid, usernames);
      remember(v);
      const g = await gc();
      await g.onMembershipChanged(gid);
      // Rotate now and tell new members the (encrypted) group name.
      await sendGroupMeta(gid, groupName(v)).catch(() => undefined);
      return groupInfoOf(v);
    },
    async removeGroupMember(gid, username) {
      const { conversation: v } = await chatApi.removeGroupMember(gid, username);
      remember(v);
      await (await gc()).onMembershipChanged(gid); // next send rotates: removed member can't read new messages
    },
    async leaveGroup(gid) {
      await chatApi.leaveGroup(gid);
      await (await gc()).forget(gid).catch(() => undefined);
      convos.delete(gid);
      threads.delete(gid);
      names.delete(gid);
    },
    async contacts() {
      await refreshConvos();
      return [...convos.values()].filter((v) => v.kind !== "group").map((v) => peerOf(v).username).filter((u) => u !== me.username);
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
      const { c, adapter, verifier } = await init();
      const conv = convos.get(conversationId);
      if (!conv) return { digits: null, changed: false };
      if (conv.kind === "group") {
        // Crypto hook: re-check every member's identity (new device -> pendingChange); only real changes block sending.
        // On open/poll: re-fetch each member's published identity so a new device is flagged now, not at first send.
        // Throttled per group: safety() also runs after every send, and /keys/identity is rate-limited (429 broke sends).
        // Kept in sessionStorage so a reload doesn't re-burst the rate-limited endpoint.
        const ck = `e2ee.idCheck.${me.id}.${conversationId}`;
        // The re-check is one batched lookup for all members (POST /keys/identity/batch, deduped GETs before it ships);
        // between checks refreshMembers reuses the identities verified for this membership version.
        const last = Math.max(identityCheckedAt.get(conversationId) ?? 0, Number(sessionStorage.getItem(ck) ?? 0));
        const force = Date.now() - last > 60_000;
        if (force) {
          identityCheckedAt.set(conversationId, Date.now());
          try { sessionStorage.setItem(ck, String(Date.now())); } catch { /* storage unavailable */ }
        }
        let ids: { userId: string }[];
        try { const r = await (await gc()).refreshMembers(conversationId, { force }); groupPending.set(conversationId, r.pending); ids = r.identities; }
        catch { ids = await (await gc()).getPendingIdentities(conversationId).catch(() => []); }
        if (!ids.length) return { digits: null, changed: false };
        const first = ids[0]!.userId;
        const name = conv.members.find((m) => c.userIdFor(m.username) === first)?.username;
        return { digits: null, changed: true, changeKind: await changeKind(first), ...(name ? { memberName: name } : {}) };
      }
      const peerId = c.userIdFor(peerOf(conv).username);
      // Re-check the peer's published identity on open, so a device change shows the banner before the first send fails.
      try { note([await verifier.refresh(peerId)]); } catch { /* offline: fall back to the cached state */ }
      const pending = changed.get(peerId) ?? (await peers.get(peerId))?.pendingChange;
      const peer = pending ?? (await peers.get(peerId))?.identity ?? (await adapter.peerIdentities(peerId))[0];
      const digits = peer ? c.formatSafetyNumber(await c.safetyNumber(adapter.identity(), peer)) : null;
      return pending ? { digits, changed: true, changeKind: await changeKind(peerId) } : { digits, changed: false };
    },
    async acceptNewIdentity(conversationId) {
      const { c, verifier } = await init();
      const conv = convos.get(conversationId);
      if (!conv) return;
      if (conv.kind === "group") {
        // Explicit user click only: accept each changed member and let crypto push them the held/older keys.
        const g = await gc();
        for (const { userId } of await g.getPendingIdentities(conversationId)) { await g.acceptMemberIdentity(conversationId, userId); changed.delete(userId); }
        return;
      }
      const peerId = c.userIdFor(peerOf(conv).username);
      const id = changed.get(peerId) ?? (await peers.get(peerId))?.pendingChange;
      if (id) { await verifier.acceptNewIdentity(id); changed.delete(peerId); }
      // Only now (user accepted the new safety number) re-send messages stranded on the peer's old device.
      await resender().resendPending(conversationId).catch(() => undefined);
    },
    async pendingResends(conversationId) {
      await init();
      return (await resender().pendingResends(conversationId)).map((p) => ({ clientId: p.clientMsgId, messageId: p.messageId, hasText: p.text !== null }));
    },
    async resendPending(conversationId) {
      await init();
      return resender().resendPending(conversationId);
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
