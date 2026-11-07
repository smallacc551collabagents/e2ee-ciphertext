"use client";
import { useEffect, useState } from "react";
import type { Tick } from "./model";
import { nullReceipts, onReceiptsAdapterChange, receiptsAdapter, type ReceiptsAdapter } from "./adapter";

const LABEL: Record<Tick, string> = { none: "", pending: "Sending…", failed: "Failed", sent: "Sent", delivered: "Delivered", read: "Read" };

/** WhatsApp msg-dblcheck: one path, second check offset right and overlapping the first. The path bounds are 16×15; it is drawn in a 16×11 slot. */
function DoubleCheck() {
  return (
    <svg viewBox="0 0 16 15" width="16" height="11" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false" className="inline-block align-[-1px]">
      <path fill="currentColor" d="M15.01 3.316l-.478-.372a.365.365 0 0 0-.51.063L8.666 9.879a.32.32 0 0 1-.484.033l-.358-.325a.319.319 0 0 0-.484.032l-.378.483a.418.418 0 0 0 .036.541l1.32 1.266c.143.14.361.125.484-.033l6.272-8.048a.366.366 0 0 0-.064-.512zm-4.1 0l-.478-.372a.365.365 0 0 0-.51.063L4.566 9.879a.32.32 0 0 1-.484.033L1.891 7.769a.366.366 0 0 0-.515.006l-.423.433a.364.364 0 0 0 .006.514l3.258 3.185c.143.14.361.125.484-.033l6.272-8.048a.365.365 0 0 0-.063-.51z" />
    </svg>
  );
}

export function Ticks({ tick }: { tick: Tick }) {
  if (tick === "none") return null;
  if (tick === "pending" || tick === "failed") return <span data-status={tick}>{LABEL[tick]}</span>;
  const color = tick === "read" ? "text-[#53bdeb]" : tick === "delivered" ? "text-[#8696a0]" : "text-blue-100";
  return (
    <span data-status={tick} data-testid="ticks" aria-label={LABEL[tick]} title={LABEL[tick]} className={color}>
      {tick === "sent" ? "✓" : <DoubleCheck />}
    </span>
  );
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
