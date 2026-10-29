"use client";
import { TEST_ACCOUNT_USERNAMES } from "@/lib/test-accounts";

export function TestAccountCards({ busy, active, onPick }: { busy: boolean; active: string | null; onPick: (u: string) => void }) {
  return (
    <section aria-label="Quick test accounts" className="mb-6">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Test accounts</h2>
      <ul className="flex flex-wrap gap-2">
        {TEST_ACCOUNT_USERNAMES.map((u) => {
          const loading = active === u;
          return (
            <li key={u}>
              <button type="button" onClick={() => onPick(u)} disabled={busy}
                aria-label={`Sign in as ${u}`} aria-busy={loading} title={u}
                className="flex h-16 w-16 max-h-[70px] max-w-[70px] flex-col items-center justify-center gap-1 rounded-lg bg-white px-1 ring-1 ring-slate-200 hover:bg-indigo-50 hover:ring-indigo-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-60">
                <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-600 text-xs font-semibold text-white">
                  {loading ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" /> : u.slice(-1)}
                </span>
                <span className="w-full truncate text-center text-[11px] text-slate-700">{u}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
