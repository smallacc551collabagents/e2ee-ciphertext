"use client";
import { useState, type FormEvent } from "react";
import { conversations as initial, type Message, type MessageStatus } from "./fixtures";

const STATUS_LABEL: Record<MessageStatus, string> = {
  sending: "Sending…", sent: "Sent", delivered: "Delivered", read: "Read", failed: "Failed",
};

export function ChatView({ username }: { username: string }) {
  const [convos, setConvos] = useState(initial);
  const [activeId, setActiveId] = useState(initial[0]?.id ?? null);
  const active = convos.find((c) => c.id === activeId) ?? null;

  const updateMsg = (id: string, patch: Partial<Message>) =>
    setConvos((cs) => cs.map((c) => ({ ...c, messages: c.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) })));

  // Mock send lifecycle (no network): sending -> sent.
  const fakeSend = (id: string) => {
    updateMsg(id, { status: "sending" });
    setTimeout(() => updateMsg(id, { status: "sent" }), 600);
  };

  function onSend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const text = String(new FormData(form).get("text") ?? "").trim();
    if (!text || !active) return;
    const id = `local-${Date.now()}`;
    const msg: Message = { id, fromMe: true, text, at: "now", status: "sending" };
    setConvos((cs) => cs.map((c) => (c.id === active.id ? { ...c, lastMessage: text, messages: [...c.messages, msg] } : c)));
    form.reset();
    fakeSend(id);
  }

  return (
    <div className="flex h-full">
      <aside className="w-72 shrink-0 overflow-y-auto border-r bg-white" aria-label="Conversations">
        <div className="border-b p-3 text-xs text-slate-500">Signed in as <strong>@{username}</strong> · mock data</div>
        {convos.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No conversations yet.</p>
        ) : (
          <ul>
            {convos.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => setActiveId(c.id)} aria-current={c.id === activeId}
                  className={`flex w-full items-center justify-between px-4 py-3 text-left hover:bg-slate-50 ${c.id === activeId ? "bg-indigo-50" : ""}`}>
                  <span className="min-w-0">
                    <span className="block font-medium">{c.peer}</span>
                    <span className="block truncate text-sm text-slate-500">{c.lastMessage || "No messages yet"}</span>
                  </span>
                  {c.unread > 0 && (
                    <span className="ml-2 rounded-full bg-indigo-600 px-2 text-xs text-white" aria-label={`${c.unread} unread`}>{c.unread}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <section className="flex min-w-0 flex-1 flex-col" aria-label="Messages">
        {!active ? (
          <p className="m-auto text-slate-500">Select a conversation</p>
        ) : (
          <>
            <div className="flex items-center justify-between border-b bg-white px-4 py-2">
              <h1 className="font-semibold">{active.peer}</h1>
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800" title="Encryption not wired yet">
                🔒 End-to-end encrypted (placeholder)
              </span>
            </div>
            <ol className="flex-1 space-y-2 overflow-y-auto p-4" aria-live="polite">
              {active.messages.length === 0 && <li className="text-center text-sm text-slate-500">No messages yet. Say hi!</li>}
              {active.messages.map((m) => (
                <li key={m.id} className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-md rounded-2xl px-3 py-2 ${m.fromMe ? "bg-indigo-600 text-white" : "bg-white ring-1 ring-slate-200"}`}>
                    {/* Plain text only: React escapes; never dangerouslySetInnerHTML. */}
                    <p className="whitespace-pre-wrap break-words">{m.text}</p>
                    <p className={`mt-1 text-[11px] ${m.fromMe ? "text-indigo-100" : "text-slate-400"}`}>
                      {m.at}
                      {m.fromMe && <> · <span data-status={m.status}>{STATUS_LABEL[m.status]}</span></>}
                      {m.fromMe && m.status === "failed" && (
                        <button type="button" onClick={() => fakeSend(m.id)} className="ml-2 underline">Retry</button>
                      )}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            <form onSubmit={onSend} className="flex gap-2 border-t bg-white p-3">
              <label htmlFor="composer" className="sr-only">Message</label>
              <input id="composer" name="text" autoComplete="off" placeholder="Type a message"
                className="flex-1 rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <button type="submit" className="rounded-md bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700">Send</button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
