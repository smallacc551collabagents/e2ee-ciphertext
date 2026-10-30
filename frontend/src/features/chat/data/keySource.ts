// "Unverified sender" badge bookkeeping (crypto #81 keySource). Pure helpers so they can be unit-tested.
export type KeySource = "sender" | "forwarded";
type BadgeView = { id: string; fromMe: boolean; system?: boolean; unverifiedSender?: boolean };

/** Record one decrypt result; returns true when the set changed. 'sender' later clears a 'forwarded' mark. */
export function noteKeySource(forwarded: Set<string>, id: string, ks: KeySource | undefined): boolean {
  if (ks === "forwarded" && !forwarded.has(id)) { forwarded.add(id); return true; }
  if (ks === "sender") return forwarded.delete(id);
  return false;
}

/** Badge = someone else's (non-system) message whose key was forwarded. Returns the same object when unchanged. */
export function withBadge<T extends BadgeView>(v: T, forwarded: Set<string>): T {
  const u = !v.fromMe && !v.system && forwarded.has(v.id);
  return !!v.unverifiedSender === u ? v : { ...v, unverifiedSender: u || undefined };
}

/** Groups whose forwarded session crypto upgraded to 'sender' (receiveToDevice().upgraded): tells the open view to refresh. */
export function createUpgradeNotifier() {
  const subs = new Set<(groupId: string) => void>();
  return {
    subscribe(cb: (groupId: string) => void) { subs.add(cb); return () => { subs.delete(cb); }; },
    notify(groupIds: readonly string[] | undefined) { for (const g of new Set(groupIds ?? [])) for (const cb of [...subs]) { try { cb(g); } catch { /* listener bug: ignore */ } } },
  };
}
