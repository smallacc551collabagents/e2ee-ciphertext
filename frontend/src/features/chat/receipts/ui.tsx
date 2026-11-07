"use client";
import { useEffect, useState } from "react";
import type { Tick } from "./model";
import { nullReceipts, onReceiptsAdapterChange, receiptsAdapter, type ReceiptsAdapter } from "./adapter";

const LABEL: Record<Tick, string> = { none: "", pending: "Sending…", failed: "Failed", sent: "Sent", delivered: "Delivered", read: "Read" };

export function Ticks({ tick }: { tick: Tick }) {
  if (tick === "none") return null;
  if (tick === "pending" || tick === "failed") return <span data-status={tick}>{LABEL[tick]}</span>;
  const glyph = tick === "sent" ? "✓" : "✓✓";
  return <span data-status={tick} data-testid="ticks" aria-label={LABEL[tick]} title={LABEL[tick]} className={tick === "read" ? "font-semibold text-sky-300" : "text-blue-100"}>{glyph}</span>;
}

/** Settings > Privacy: "Last seen". Hiding yours also hides others' last seen from you. Disabled until backend lands. */
export function LastSeenToggle() {
  // null on the first paint (matches SSR). The live adapter is installed after hydration.
  const [a, setA] = useState<ReceiptsAdapter>(nullReceipts);
  const [on, setOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  useEffect(() => {
    const sync = () => setA(receiptsAdapter());
    sync();
    return onReceiptsAdapterChange(sync);
  }, []);
  useEffect(() => {
    if (!a.available) return;
    let live = true;
    a.getLastSeenVisible().then((v) => { if (live) setOn(v); }, (e: unknown) => { if (live && (e as { status?: number })?.status === 404) setUnsupported(true); });
    return () => { live = false; };
  }, [a]);
  return (
    <li className="flex items-center justify-between py-3 text-sm">
      <span>Last seen<span className="block text-xs text-slate-500">If you hide yours, you won’t see other people’s.</span></span>
      <input type="checkbox" role="switch" aria-label="Last seen" checked={on} disabled={!a.available || busy || unsupported}
        onChange={(e) => {
          const v = e.target.checked; setBusy(true); setOn(v);
          a.setLastSeenVisible(v).catch((err: unknown) => { setOn(!v); if ((err as { status?: number })?.status === 404) setUnsupported(true); }).finally(() => setBusy(false));
        }}
        className="h-5 w-9 disabled:cursor-not-allowed" />
    </li>
  );
}
