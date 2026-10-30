// Pure helpers for groups whose name/state this device can't decrypt yet (new device, key not arrived).

export const ENCRYPTED_GROUP_NAME = "Encrypted group";

/**
 * Sidebar label for a group; never throws, so one bad group can't drop the others.
 * Decrypted name -> that name. Otherwise member usernames (as before). If that can't be built (lookup throws / empty)
 * -> "Encrypted group" with nameKnown=false (lock icon), still openable; it switches live once the name decrypts.
 */
export function groupLabel(name: string | undefined, memberNames?: () => string[]): { name: string; nameKnown: boolean } {
  const n = typeof name === "string" ? name.trim() : "";
  if (n) return { name: n, nameKnown: true };
  try {
    const m = (memberNames?.() ?? []).filter(Boolean).join(", ");
    if (m) return { name: m, nameKnown: true };
  } catch { /* member lookup failed: fall back below */ }
  return { name: ENCRYPTED_GROUP_NAME, nameKnown: false };
}

/** Groups to fetch in the background because their name is still unknown (throttled per group). */
export function groupsToWarm(groupIds: readonly string[], known: (id: string) => boolean, lastTry: Map<string, number>, now: number, everyMs = 15_000): string[] {
  const out: string[] = [];
  for (const id of groupIds) {
    if (known(id)) continue;
    if (now - (lastTry.get(id) ?? -Infinity) < everyMs) continue;
    lastTry.set(id, now);
    out.push(id);
  }
  return out;
}
