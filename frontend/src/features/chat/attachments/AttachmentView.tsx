"use client";
import { useEffect, useRef, useState } from "react";
import { AttachmentError, type Phase } from "./flow";

const PREVIEWABLE = /^image\/(png|jpeg|gif|webp)$/; // never svg/html: rendered only as <img> from a decrypted blob

type State =
  | { s: "idle" } | { s: "busy"; phase: Phase; f?: number }
  | { s: "ready"; url: string; name: string; mime: string; size: number }
  | { s: "expired" } | { s: "error"; message: string; retryable: boolean };

export function AttachmentView({ descriptor, open, display }: {
  descriptor: unknown;
  open: (d: unknown, onPhase: (p: Phase, f?: number) => void) => Promise<{ bytes: Uint8Array; name: string; mime: string }>;
  display: (s: string) => string;
}) {
  const [st, setSt] = useState<State>({ s: "idle" });
  const urlRef = useRef<string | null>(null);
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  async function load() {
    setSt({ s: "busy", phase: "downloading" });
    try {
      const r = await open(descriptor, (phase, f) => setSt({ s: "busy", phase, f }));
      const mime = PREVIEWABLE.test(r.mime) ? r.mime : "application/octet-stream";
      const url = URL.createObjectURL(new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: mime }));
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setSt({ s: "ready", url, name: display(r.name), mime, size: r.bytes.byteLength });
    } catch (e) {
      if (e instanceof AttachmentError && e.code === "expired") setSt({ s: "expired" });
      else setSt({ s: "error", message: e instanceof AttachmentError ? e.message : "Couldn’t open attachment", retryable: e instanceof AttachmentError ? e.retryable : true });
    }
  }

  if (st.s === "expired") return <p data-testid="attachment-expired" role="status" className="text-sm italic text-slate-500">Attachment expired</p>;
  if (st.s === "error") return (
    <p data-testid="attachment-error" role="alert" className="text-sm text-red-600">
      {st.message}{st.retryable && <button type="button" onClick={() => void load()} className="ml-2 underline">Retry</button>}
    </p>
  );
  if (st.s === "busy") return (
    <div role="status" aria-live="polite" className="text-sm">
      {st.phase === "decrypting" ? "Decrypting…" : "Downloading…"}
      <progress className="ml-2 align-middle" max={1} value={st.f ?? undefined} aria-label="Attachment download progress" />
    </div>
  );
  if (st.s === "ready") return (
    <div data-testid="attachment-ready" className="text-sm">
      {st.mime.startsWith("image/") && <img src={st.url} alt={st.name} className="mb-1 max-h-64 rounded-lg" />}
      <a href={st.url} download={st.name} className="underline">{st.name}</a>
    </div>
  );
  return <button type="button" data-testid="attachment-open" onClick={() => void load()} className="text-sm underline">📎 Open encrypted attachment</button>;
}
