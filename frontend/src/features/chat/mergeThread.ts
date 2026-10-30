// Merge a freshly listed thread (seq order, from the adapter) with what is on screen.
// Every server row is keyed by its messageId, so a "Waiting for this message's key" placeholder is replaced in
// place when that message decrypts (fresh carries it at the same seq). Only local, not-yet-acknowledged own sends
// (optimistic rows) that the server list doesn't contain yet are kept, after the server rows.
type Row = { id: string; clientId?: string; fromMe: boolean; status: string; text?: string; unverifiedSender?: boolean };

/** Fields that change what a row looks like. A keySource upgrade flips only `unverifiedSender`, and it must still re-render. */
export function sameRow(a: Row, b: Row): boolean {
  return a === b || (a.id === b.id && a.clientId === b.clientId && a.status === b.status && a.text === b.text && !!a.unverifiedSender === !!b.unverifiedSender);
}

export function mergeThread<T extends Row>(current: readonly T[], fresh: readonly T[]): readonly T[] {
  const ids = new Set<string>();
  for (const m of fresh) { ids.add(m.id); if (m.clientId) ids.add(m.clientId); }
  const keep = current.filter((m) => m.fromMe && m.status !== "sent" && !ids.has(m.id) && !(m.clientId && ids.has(m.clientId)));
  const next = keep.length ? [...fresh, ...keep] : fresh;
  // Unchanged rows (incl. the badge) => same array, so React skips the re-render; any badge flip counts as a change.
  return next.length === current.length && next.every((m, i) => sameRow(m, current[i]!)) ? current : next;
}
