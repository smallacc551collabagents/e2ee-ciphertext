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
