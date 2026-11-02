"use client";
import { useEffect, useState } from "react";
import type { Tick } from "./model";
import { receiptsAdapter } from "./adapter";

const LABEL: Record<Tick, string> = { none: "", pending: "Sending…", failed: "Failed", sent: "Sent", delivered: "Delivered", read: "Read" };

export function Ticks({ tick }: { tick: Tick }) {
  if (tick === "none") return null;
  if (tick === "pending" || tick === "failed") return <span data-status={tick}>{LABEL[tick]}</span>;
  const glyph = tick === "sent" ? "✓" : "✓✓";
  return <span data-status={tick} data-testid="ticks" aria-label={LABEL[tick]} title={LABEL[tick]} className={tick === "read" ? "font-semibold text-sky-300" : "text-blue-100"}>{glyph}</span>;
}

/** Settings > Privacy: "Last seen". Hiding yours also hides others' last seen from you. Disabled until backend lands. */
export function LastSeenToggle() {
  const a = receiptsAdapter();
  const [on, setOn] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (a.available) void a.getLastSeenVisible().then(setOn, () => undefined); }, [a]);
  return (
    <li className="flex items-center justify-between py-3 text-sm">
      <span>Last seen<span className="block text-xs text-slate-500">If you hide yours, you won’t see other people’s.</span></span>
      <input type="checkbox" role="switch" aria-label="Last seen" checked={on} disabled={!a.available || busy}
        onChange={(e) => { const v = e.target.checked; setBusy(true); setOn(v); a.setLastSeenVisible(v).catch(() => setOn(!v)).finally(() => setBusy(false)); }}
        className="h-5 w-9 disabled:cursor-not-allowed" />
    </li>
  );
}
