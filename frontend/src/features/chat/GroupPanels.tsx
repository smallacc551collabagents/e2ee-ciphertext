"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ChatAdapter, ConversationView, GroupInfo } from "./data";
import { addCandidates, GROUP_MAX_MEMBERS, groupErrorMessage } from "./groupCopy";

function Picker({ options, picked, onToggle, disabled, max }: { options: string[]; picked: Set<string>; onToggle: (u: string) => void; disabled?: boolean; max: number }) {
  if (!options.length) return <p className="mt-2 text-sm text-slate-500">No one to add. You can only add people you already have a 1:1 chat with.</p>;
  return (
    <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto" data-testid="member-picker">
      {options.map((u) => {
        const on = picked.has(u);
        return (
          <li key={u}>
            <label className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50">
              <input type="checkbox" checked={on} disabled={disabled || (!on && picked.size >= max)} onChange={() => onToggle(u)} />
              <span>@{u}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function useEsc(onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose, active]);
}

export function CreateGroupDialog({ adapter, onClose, onCreated }: { adapter: ChatAdapter; onClose: () => void; onCreated: (c: ConversationView) => void }) {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [contacts, setContacts] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEsc(onClose, !busy);
  useEffect(() => { nameRef.current?.focus(); adapter.contacts?.().then(setContacts, () => setContacts([])); }, [adapter]);
  const toggle = (u: string) => setPicked((s) => { const n = new Set(s); if (n.has(u)) n.delete(u); else n.add(u); return n; });
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !adapter.createGroup) return;
    const n = name.trim();
    if (!n) { setError("Give the group a name."); return; }
    if (!picked.size) { setError("Pick at least one person."); return; }
    setBusy(true); setError(null);
    try { onCreated(await adapter.createGroup(n, [...picked])); } catch (err) { setError(groupErrorMessage(err)); setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form role="dialog" aria-modal="true" aria-labelledby="new-group-title" onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
        <h2 id="new-group-title" className="text-lg font-semibold">New group</h2>
        <label htmlFor="group-name" className="mt-3 block text-sm text-slate-600">Group name</label>
        <input ref={nameRef} id="group-name" maxLength={64} value={name} disabled={busy} onChange={(e) => setName(e.target.value)} autoComplete="off"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <p className="mt-1 text-xs text-slate-500">The name is end-to-end encrypted.</p>
        <label htmlFor="group-search" className="mt-3 block text-sm text-slate-600">Members ({picked.size}/{GROUP_MAX_MEMBERS - 1})</label>
        <input id="group-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your chats" disabled={busy}
          className="mt-1 w-full rounded-lg bg-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        {contacts === null ? <p className="mt-2 text-sm text-slate-400" aria-busy="true">Loading…</p>
          : <Picker options={addCandidates(contacts, [], query)} picked={picked} onToggle={toggle} disabled={busy} max={GROUP_MAX_MEMBERS - 1} />}
        {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
          <button type="submit" disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">{busy ? "Creating…" : "Create group"}</button>
        </div>
      </form>
    </div>
  );
}

export function MembersPanel({ adapter, conversationId, meId, onLeft, onChanged }: { adapter: ChatAdapter; conversationId: string; meId: string; onLeft: () => void; onChanged: () => void }) {
  const [info, setInfo] = useState<GroupInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<null | { query: string; picked: Set<string>; contacts: string[] | null }>(null);
  const [busy, setBusy] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const load = () => adapter.groupInfo?.(conversationId).then(setInfo, (e) => setError(groupErrorMessage(e)));
  useEffect(() => { setInfo(null); void load(); }, [conversationId, adapter]);
  async function run(f: () => Promise<unknown>, after?: () => void) {
    setBusy(true); setError(null);
    try { await f(); after?.(); if (after !== onLeft) await load(); onChanged(); } catch (e) { setError(groupErrorMessage(e)); } finally { setBusy(false); }
  }
  const openAdd = () => { setAdding({ query: "", picked: new Set(), contacts: null }); adapter.contacts?.().then((c) => setAdding((s) => (s ? { ...s, contacts: c } : s)), () => setAdding((s) => (s ? { ...s, contacts: [] } : s))); };
  const room = info ? GROUP_MAX_MEMBERS - info.members.length : 0;
  return (
    <aside aria-label="Group members" data-testid="members-panel" className="border-b border-slate-200 bg-white px-4 py-3 text-sm">
      <div className="flex items-center justify-between">
        <p className="font-medium">Members{info ? ` (${info.members.length}/${GROUP_MAX_MEMBERS})` : ""}</p>
        {info && <button type="button" onClick={openAdd} disabled={busy || room <= 0} className="rounded-full bg-blue-50 px-3 py-1 text-blue-700 disabled:opacity-50">Add members</button>}
      </div>
      {!info && !error && <p className="mt-2 text-slate-400" aria-busy="true">Loading…</p>}
      {info && (
        <ul className="mt-2 space-y-1" data-testid="member-list">
          {info.members.map((m) => {
            const isAdmin = m.id === info.adminId, isMe = m.id === meId;
            return (
              <li key={m.id} data-testid="member" data-username={m.username} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1">
                <span>@{m.username}{isMe && <span className="text-slate-500"> (you)</span>}
                  {isAdmin && <span data-testid="admin-badge" className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800">Admin</span>}</span>
                {!isAdmin && !isMe && (confirmRemove === m.username ? (
                  <span className="flex gap-2">
                    <button type="button" disabled={busy} onClick={() => void run(() => adapter.removeGroupMember!(conversationId, m.username), () => setConfirmRemove(null))} className="text-red-600 underline">Confirm remove</button>
                    <button type="button" onClick={() => setConfirmRemove(null)} className="underline">Cancel</button>
                  </span>
                ) : (
                  <button type="button" disabled={busy} aria-label={`Remove ${m.username}`} onClick={() => setConfirmRemove(m.username)} className="text-red-600 underline disabled:opacity-50">Remove</button>
                ))}
              </li>
            );
          })}
        </ul>
      )}
      {adding && (
        <div className="mt-3 rounded-lg bg-slate-50 p-3" data-testid="add-members">
          <input type="search" aria-label="Search your chats" value={adding.query} onChange={(e) => setAdding({ ...adding, query: e.target.value })} placeholder="Search your chats"
            className="w-full rounded-lg bg-white px-3 py-2 ring-1 ring-slate-200" />
          {adding.contacts === null ? <p className="mt-2 text-slate-400">Loading…</p> : (
            <Picker options={addCandidates(adding.contacts, info?.members ?? [], adding.query)} picked={adding.picked} max={room} disabled={busy}
              onToggle={(u) => setAdding((s) => { if (!s) return s; const n = new Set(s.picked); if (n.has(u)) n.delete(u); else n.add(u); return { ...s, picked: n }; })} />
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setAdding(null)} className="rounded-lg px-3 py-1 text-slate-600">Cancel</button>
            <button type="button" disabled={busy || !adding.picked.size} onClick={() => void run(() => adapter.addGroupMembers!(conversationId, [...adding.picked]), () => setAdding(null))}
              className="rounded-lg bg-blue-600 px-3 py-1 font-semibold text-white disabled:opacity-60">Add</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-red-600">{error}</p>}
      <div className="mt-3 border-t border-slate-100 pt-3">
        {confirmLeave ? (
          <div role="alertdialog" aria-label="Leave group" className="flex flex-wrap items-center gap-2">
            <span>{info?.adminId === meId ? "Leave this group? The longest-standing member becomes admin." : "Leave this group? You won’t get new messages."}</span>
            <button type="button" disabled={busy} onClick={() => void run(() => adapter.leaveGroup!(conversationId), onLeft)} className="rounded-full bg-red-600 px-3 py-1 text-white">Leave</button>
            <button type="button" onClick={() => setConfirmLeave(false)} className="underline">Cancel</button>
          </div>
        ) : (
          <button type="button" disabled={busy || !adapter.leaveGroup} onClick={() => setConfirmLeave(true)} className="text-red-600 underline">Leave group</button>
        )}
      </div>
    </aside>
  );
}
