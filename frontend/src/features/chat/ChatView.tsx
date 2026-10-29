"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { chatAdapter, FeatureUnavailableError, IdentityChangedError, NewDeviceRequiredError, type SafetyInfo, type ConversationView, type MessageStatus, type MessageView } from "./data";
import { AttachmentView } from "./attachments/AttachmentView";
import { AttachmentError, type Phase } from "./attachments/flow";
import { changeKindLabel, identityWarning, NEW_DEVICE_COPY } from "./identityCopy";
import { newChatErrorMessage, validatePeerUsername } from "./newChat";
import { avatarColor, clockTime, dayLabel, initials, listTime } from "./format";

const STATUS_LABEL: Record<MessageStatus, string> = {
  sending: "Sending…", sent: "✓ Sent", delivered: "✓✓ Delivered", read: "✓✓ Read", failed: "Failed",
};

type Load<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "error" } | { state: "unavailable" };
const toLoad = <T,>(e: unknown): Load<T> => (e instanceof FeatureUnavailableError ? { state: "unavailable" } : { state: "error" });

function Avatar({ name, size = "h-10 w-10" }: { name: string; size?: string }) {
  return (
    <span aria-hidden className={`${size} ${avatarColor(name)} flex shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white`}>
      {initials(name)}
    </span>
  );
}

function LockBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700">
      <svg aria-hidden viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
      End-to-end encrypted
    </span>
  );
}

export function ChatView({ username, userId = "" }: { username: string; userId?: string }) {
  const adapter = useMemo(() => chatAdapter(userId ? { id: userId, username } : undefined), [userId, username]);
  const [safety, setSafety] = useState<SafetyInfo | null>(null);
  // E2EE-79: check the local device before anything that could publish keys.
  const [device, setDevice] = useState<"checking" | "ok" | "confirm" | "confirming">(adapter.deviceState ? "checking" : "ok");
  useEffect(() => {
    if (!adapter.deviceState) return;
    let live = true;
    adapter.deviceState().then((s) => live && setDevice(s === "needs-new-device-confirmation" ? "confirm" : "ok"), () => live && setDevice("ok"));
    return () => { live = false; };
  }, [adapter]);
  const [showInfo, setShowInfo] = useState(false);
  const [convos, setConvos] = useState<Load<ConversationView[]>>({ state: "loading" });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Load<MessageView[]>>({ state: "loading" });
  const [query, setQuery] = useState("");
  const [newChat, setNewChat] = useState<null | { value: string; error?: string; busy?: boolean }>(null);
  const newChatBtn = useRef<HTMLButtonElement>(null);
  const closeNewChat = () => { setNewChat(null); newChatBtn.current?.focus(); };
  const newChatInput = useRef<HTMLInputElement>(null);
  const newChatOpen = !!newChat, newChatBusy = !!newChat?.busy, newChatErr = newChat?.error;
  useEffect(() => {
    if (!newChatOpen || newChatBusy) return;
    newChatInput.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setNewChat(null); newChatBtn.current?.focus(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [newChatOpen, newChatBusy, newChatErr]);
  async function submitNewChat(e: FormEvent) {
    e.preventDefault();
    if (!newChat || newChat.busy || !adapter.createConversation) return;
    const name = newChat.value.trim().replace(/^@/, "");
    const invalid = validatePeerUsername(name, username);
    if (invalid) { setNewChat({ value: newChat.value, error: invalid }); return; }
    setNewChat({ value: newChat.value, busy: true });
    try {
      const conv = await adapter.createConversation(name);
      setConvos((s) => (s.state === "ready" ? { ...s, data: [conv, ...s.data.filter((c) => c.id !== conv.id)] } : { state: "ready", data: [conv] }));
      setNewChat(null);
      setActiveId(conv.id);
    } catch (err) {
      setNewChat({ value: newChat.value, error: newChatErrorMessage(err, name) });
    }
  }
  const listEnd = useRef<HTMLLIElement>(null);

  const loadConvos = useCallback(() => {
    setConvos({ state: "loading" });
    adapter.listConversations().then((data) => setConvos({ state: "ready", data }), (e) => { if (e instanceof NewDeviceRequiredError) setDevice("confirm"); setConvos(toLoad(e)); });
  }, [adapter]);
  useEffect(() => { if (device === "ok") loadConvos(); }, [device, loadConvos]);

  const loadMsgs = useCallback((id: string) => {
    setMsgs({ state: "loading" });
    adapter.listMessages(id).then((data) => setMsgs({ state: "ready", data }), (e) => { if (e instanceof NewDeviceRequiredError) setDevice("confirm"); setMsgs(toLoad(e)); })
      .finally(() => { void adapter.safety?.(id).then(setSafety, () => setSafety(null)); });
  }, [adapter]);
  useEffect(() => { setSafety(null); setShowInfo(false); }, [activeId]);

  // No push yet: poll with the after-cursor on focus, reconnect, and every few seconds while visible.
  useEffect(() => {
    if (!activeId || adapter.id !== "live") return;
    let busy = false;
    const poll = async () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      try {
        const fresh = await adapter.listMessages(activeId);
        setMsgs((s) => {
          if (s.state !== "ready") return { state: "ready", data: fresh };
          const known = new Set(fresh.map((m) => m.clientId ?? m.id));
          return { state: "ready", data: [...fresh, ...s.data.filter((m) => m.status !== "sent" && !known.has(m.clientId ?? m.id))] };
        });
      } catch { /* keep current view; next tick retries */ } finally { busy = false; }
    };
    const t = setInterval(() => void poll(), 4000);
    window.addEventListener("focus", poll);
    window.addEventListener("online", poll);
    document.addEventListener("visibilitychange", poll);
    return () => { clearInterval(t); window.removeEventListener("focus", poll); window.removeEventListener("online", poll); document.removeEventListener("visibilitychange", poll); };
  }, [activeId, adapter]);

  async function acceptIdentity() {
    if (!activeId || !adapter.acceptNewIdentity) return;
    await adapter.acceptNewIdentity(activeId);
    setSafety(await adapter.safety!(activeId));
  }
  useEffect(() => { if (activeId) loadMsgs(activeId); }, [activeId, loadMsgs]);
  useEffect(() => { listEnd.current?.scrollIntoView?.({ block: "end" }); }, [msgs]);

  const list = convos.state === "ready" ? convos.data : [];
  const filtered = list.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()));
  const active = list.find((c) => c.id === activeId) ?? null;

  const patch = (clientId: string, p: Partial<MessageView>) =>
    setMsgs((s) => (s.state === "ready" ? { ...s, data: s.data.map((m) => (m.clientId === clientId ? { ...m, ...p } : m)) } : s));

  async function send(text: string, clientId: string) {
    if (!activeId) return;
    patch(clientId, { status: "sending" });
    try {
      const saved = await adapter.sendMessage(activeId, text, clientId);
      patch(clientId, { ...saved, clientId });
      setConvos((s) => (s.state === "ready" ? { ...s, data: s.data.map((c) => (c.id === activeId ? { ...c, preview: text, lastActivityAt: saved.sentAt } : c)) } : s));
    } catch (e) {
      patch(clientId, { status: "failed" });
      if (e instanceof IdentityChangedError && adapter.safety) setSafety(await adapter.safety(activeId));
    }
  }

  const [upload, setUpload] = useState<null | { file: File; phase?: Phase; f?: number; error?: string; retryable?: boolean }>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  async function sendFile(file: File) {
    if (!activeId || !adapter.sendAttachment) return;
    setUpload({ file, phase: "encrypting" });
    try {
      const saved = await adapter.sendAttachment(activeId, file, crypto.randomUUID(), (phase, f) => setUpload({ file, phase, f }));
      setMsgs((s) => (s.state === "ready" ? { ...s, data: [...s.data, saved] } : s));
      setUpload(null);
    } catch (e) {
      const ae = e instanceof AttachmentError ? e : null;
      setUpload({ file, error: ae?.message ?? "Couldn’t send attachment", retryable: ae ? ae.retryable : true });
    }
  }

  function onSend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const text = String(new FormData(form).get("text") ?? "").trim();
    if (!text || msgs.state !== "ready") return;
    const clientId = crypto.randomUUID();
    const optimistic: MessageView = { id: clientId, clientId, fromMe: true, text, sentAt: new Date().toISOString(), status: "sending" };
    setMsgs({ state: "ready", data: [...msgs.data, optimistic] });
    form.reset();
    void send(text, clientId);
  }

  async function confirmDevice() {
    if (!adapter.confirmNewDevice) return;
    setDevice("confirming");
    try { await adapter.confirmNewDevice(); setDevice("ok"); } catch { setDevice("confirm"); }
  }
  if (device !== "ok") return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      {device === "checking" ? <p aria-busy="true" className="text-sm text-slate-500">Checking this browser…</p> : (
        <section role="dialog" aria-modal="true" aria-labelledby="new-device-title" data-testid="new-device" className="max-w-md rounded-2xl bg-white p-6 ring-1 ring-slate-200">
          <h1 id="new-device-title" className="text-lg font-semibold">{NEW_DEVICE_COPY.title}</h1>
          <p className="mt-3 text-sm text-slate-600">{NEW_DEVICE_COPY.body}</p>
          <button type="button" onClick={() => void confirmDevice()} disabled={device === "confirming"} className="mt-5 rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
            {device === "confirming" ? "Setting up…" : NEW_DEVICE_COPY.confirm}
          </button>
        </section>
      )}
    </main>
  );

  return (
    <div className="flex h-full bg-slate-50">
      {/* Sidebar: full width on mobile when no conversation is open */}
      {newChat && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !newChat.busy) closeNewChat(); }}>
          <form role="dialog" aria-modal="true" aria-labelledby="new-chat-title" onSubmit={submitNewChat}
            className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h2 id="new-chat-title" className="text-lg font-semibold">New chat</h2>
            <label htmlFor="new-chat-username" className="mt-3 block text-sm text-slate-600">Username</label>
            <input ref={newChatInput} id="new-chat-username" autoComplete="off" spellCheck={false} maxLength={33} value={newChat.value} disabled={newChat.busy}
              aria-invalid={!!newChat.error} aria-describedby={newChat.error ? "new-chat-error" : undefined}
              onChange={(e) => setNewChat({ value: e.target.value })}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            {newChat.error && <p id="new-chat-error" role="alert" className="mt-2 text-sm text-red-600">{newChat.error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={closeNewChat} disabled={newChat.busy} className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
              <button type="submit" disabled={newChat.busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">{newChat.busy ? "Starting…" : "Start chat"}</button>
            </div>
          </form>
        </div>
      )}
      <aside aria-label="Conversations" className={`${active ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col border-r border-slate-200 bg-white md:w-[360px]`}>
        <div className="flex items-center justify-between px-4 pb-3 pt-5">
          <h2 className="text-2xl font-bold">Chats</h2>
          <button ref={newChatBtn} type="button" title="New chat" aria-label="New chat" aria-haspopup="dialog" disabled={!adapter.createConversation}
            onClick={() => setNewChat({ value: "" })}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 text-lg text-blue-700 disabled:opacity-50">+</button>
        </div>
        <div className="px-2 pb-3">
          <label htmlFor="chat-search" className="sr-only">Search conversations</label>
          <input id="chat-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search conversations"
            className="w-full rounded-lg bg-slate-100 px-3 py-2 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2" data-testid="conversation-list">
          {convos.state === "loading" && (
            <ul aria-busy="true" aria-label="Loading conversations" className="space-y-2">
              {[0, 1, 2].map((i) => <li key={i} className="h-16 animate-pulse rounded-lg bg-slate-100" />)}
            </ul>
          )}
          {convos.state === "unavailable" && (
            <div data-testid="chat-coming-soon" className="m-2 rounded-xl bg-blue-50 p-4 text-sm text-blue-900">
              <p className="font-medium">Encrypted messaging is coming soon</p>
              <p className="mt-1 text-blue-800">You’re signed in as @{username}. Conversations will appear here once secure messaging is switched on.</p>
            </div>
          )}
          {convos.state === "error" && (
            <div role="alert" className="m-2 rounded-xl bg-red-50 p-4 text-sm text-red-800">
              Couldn’t load conversations.{" "}
              <button type="button" onClick={loadConvos} className="font-medium underline">Retry</button>
            </div>
          )}
          {convos.state === "ready" && list.length === 0 && <p className="p-4 text-sm text-slate-500">No conversations yet. Use <span aria-hidden>+</span><span className="sr-only">New chat</span> to start one.</p>}
          {convos.state === "ready" && list.length > 0 && filtered.length === 0 && <p className="p-4 text-sm text-slate-500">No matches.</p>}
          {filtered.length > 0 && (
            <ul className="space-y-1 pb-2">
              {filtered.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => setActiveId(c.id)} aria-current={c.id === activeId ? "true" : undefined}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left ${c.id === activeId ? "bg-blue-50" : "hover:bg-slate-50"}`}>
                    <Avatar name={c.name} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-semibold">{c.name}</span>
                        <span className={`shrink-0 text-xs ${c.unread ? "text-blue-600" : "text-slate-400"}`}>{listTime(c.lastActivityAt)}</span>
                      </span>
                      <span className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] text-slate-500">{c.preview || "No messages yet"}</span>
                        {c.unread > 0 && <span aria-label={`${c.unread} unread`} className="min-w-5 shrink-0 rounded-full bg-blue-600 px-1.5 text-center text-[11px] font-semibold leading-5 text-white">{c.unread}</span>}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <section aria-label="Messages" className={`${active ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>
        {!active ? (
          <div className="m-auto max-w-xs text-center text-sm text-slate-500">
            <LockBadge />
            <p className="mt-3">{convos.state === "unavailable" ? "Secure messaging isn’t switched on yet." : "Select a conversation to start messaging."}</p>
          </div>
        ) : (
          <>
            <header className="flex h-[72px] items-center justify-between border-b border-slate-200 bg-white px-4">
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => setActiveId(null)} aria-label="Back to conversations" className="rounded-md p-1 text-xl md:hidden">‹</button>
                <Avatar name={active.name} />
                <div>
                  <h1 className="font-semibold">{active.name}</h1>
                  <LockBadge />
                </div>
              </div>
              <button type="button" disabled={!adapter.safety} onClick={() => setShowInfo((v) => !v)} aria-expanded={showInfo} aria-label="Conversation info" className="h-9 w-9 rounded-full text-xl text-slate-500 disabled:opacity-50">ⓘ</button>
            </header>
            {safety?.changed && (
              <div role="alert" data-testid="identity-changed" className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
                <span data-kind={safety.changeKind ?? "unknown"}>{identityWarning(active.name, safety.changeKind)}</span>
                <span className="flex gap-2">
                  <button type="button" onClick={() => setShowInfo(true)} className="underline">View safety number</button>
                  <button type="button" onClick={() => void acceptIdentity()} className="rounded-full bg-amber-600 px-3 py-1 text-white">I’ve verified it</button>
                </span>
              </div>
            )}
            {showInfo && (
              <aside aria-label="Conversation info" data-testid="safety-number" className="border-b border-slate-200 bg-white px-4 py-3 text-sm">
                <p className="font-medium">Safety number</p>
                {safety?.changed && changeKindLabel(safety.changeKind) && <p data-testid="change-kind" className="mt-1 text-amber-800">Change: {changeKindLabel(safety.changeKind)}. Sending is blocked until you verify.</p>}
                {safety?.digits ? (
                  <p className="mt-1 grid max-w-xs grid-cols-4 gap-x-3 font-mono tracking-wider">{safety.digits.map((d, i) => <span key={i}>{d}</span>)}</p>
                ) : (
                  <p className="mt-1 text-slate-500">Available after you exchange a message.</p>
                )}
                <p className="mt-2 text-xs text-slate-500">Compare these numbers with {active.name} in person or on a call.</p>
              </aside>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8">
              {msgs.state === "loading" && <p aria-busy="true" className="text-center text-sm text-slate-400">Loading messages…</p>}
              {msgs.state === "error" && (
                <p role="alert" className="text-center text-sm text-red-700">
                  Couldn’t load messages. <button type="button" className="underline" onClick={() => loadMsgs(active.id)}>Retry</button>
                </p>
              )}
              {msgs.state === "unavailable" && <p className="text-center text-sm text-slate-500">Messages are coming soon.</p>}
              {msgs.state === "ready" && (
                <ol className="flex min-h-full flex-col justify-end gap-3" aria-live="polite">
                  {msgs.data.length === 0 && <li className="text-center text-sm text-slate-500">No messages yet. Say hi!</li>}
                  {msgs.data.map((m, i) => {
                    const day = dayLabel(m.sentAt);
                    const showDay = i === 0 || dayLabel(msgs.data[i - 1]!.sentAt) !== day;
                    return (
                      <li key={m.clientId ?? m.id}>
                        {showDay && <p className="mb-3 text-center"><span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-[11px] text-slate-600">{day}</span></p>}
                        <div className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}>
                          <div data-testid="bubble" className={`max-w-[75%] rounded-2xl px-3 py-2 md:max-w-md ${m.fromMe ? "bg-blue-600 text-white" : "bg-white ring-1 ring-slate-200"}`}>
                            {/* Plain text only: React escapes; never dangerouslySetInnerHTML. */}
                            {m.attachment !== undefined && adapter.openAttachment
                              ? <AttachmentView descriptor={m.attachment} open={adapter.openAttachment} display={adapter.displayText ?? ((t) => t)} />
                              : <p className="whitespace-pre-wrap break-words text-sm">{m.text}</p>}
                            <p className={`mt-1 text-right text-[11px] ${m.fromMe ? "text-blue-100" : "text-slate-400"}`}>
                              {clockTime(m.sentAt)}
                              {m.fromMe && <> <span data-status={m.status}>{STATUS_LABEL[m.status]}</span></>}
                              {m.fromMe && m.status === "failed" && m.clientId && (
                                <button type="button" onClick={() => void send(m.text, m.clientId!)} className="ml-2 underline">Retry</button>
                              )}
                            </p>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                  <li ref={listEnd} aria-hidden />
                </ol>
              )}
            </div>
            {upload && (
              <div data-testid="upload-status" role={upload.error ? "alert" : "status"} aria-live="polite" className="flex items-center gap-2 border-t border-slate-200 bg-white px-4 py-2 text-sm">
                <span className="truncate">{(adapter.displayText ?? ((t: string) => t))(upload.file.name)}</span>
                {upload.error ? (
                  <>
                    <span className="text-red-600">{upload.error}</span>
                    {upload.retryable && <button type="button" onClick={() => void sendFile(upload.file)} className="underline">Retry</button>}
                    <button type="button" onClick={() => setUpload(null)} className="underline">Dismiss</button>
                  </>
                ) : (
                  <>
                    <span>{upload.phase === "uploading" ? "Uploading…" : upload.phase === "finalizing" ? "Finishing…" : "Encrypting…"}</span>
                    <progress max={1} value={upload.phase === "uploading" ? upload.f ?? 0 : undefined} aria-label="Attachment upload progress" />
                  </>
                )}
              </div>
            )}
            <form onSubmit={onSend} className="flex gap-2 border-t border-slate-200 bg-white px-4 py-3">
              {adapter.sendAttachment && (
                <>
                  <input ref={fileInput} type="file" className="sr-only" id="attach-file" tabIndex={-1} aria-hidden
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void sendFile(f); }} />
                  <button type="button" data-testid="attach" aria-label="Attach file" disabled={msgs.state !== "ready" || !!safety?.changed || (!!upload && !upload.error)}
                    onClick={() => fileInput.current?.click()} className="rounded-full px-3 text-lg text-slate-500 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60">📎</button>
                </>
              )}
              <label htmlFor="composer" className="sr-only">Message</label>
              <input id="composer" name="text" autoComplete="off" maxLength={4000} placeholder="Write an encrypted message…" disabled={msgs.state !== "ready" || !!safety?.changed}
                className="flex-1 rounded-full bg-slate-100 px-4 py-2.5 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60" />
              <button type="submit" disabled={msgs.state !== "ready" || !!safety?.changed} className="rounded-full bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">Send</button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
