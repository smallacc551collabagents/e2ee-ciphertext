"use client";
import { useState, type FormEvent } from "react";
import { deleteAccount } from "@/features/account/deleteAccount";
import { wipeLocalE2EE } from "@/features/chat/data/wipe";

export function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const r = await deleteAccount(password, { fetch: (...a) => fetch(...a), wipe: () => wipeLocalE2EE() });
    if (r.ok) { window.location.replace("/login"); return; }
    setBusy(false); setPassword(""); setError(r.message);
  }
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="rounded-full border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50">Delete account</button>;
  return (
    <form onSubmit={submit} aria-labelledby="delete-h" data-testid="delete-account" className="space-y-3">
      <p id="delete-h" className="text-sm text-slate-700">This permanently deletes your account, your keys and your messages on the server, and erases this browser’s encrypted history. It can’t be undone.</p>
      <label htmlFor="delete-password" className="block text-sm font-medium">Password</label>
      <input id="delete-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !password} className="rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">{busy ? "Deleting…" : "Permanently delete account"}</button>
        <button type="button" disabled={busy} onClick={() => { setOpen(false); setPassword(""); setError(null); }} className="rounded-full px-4 py-2 text-sm">Cancel</button>
      </div>
    </form>
  );
}
