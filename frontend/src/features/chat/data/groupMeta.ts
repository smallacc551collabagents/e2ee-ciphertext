// Pure helpers for groups whose name/state this device can't decrypt yet (new device, key not arrived), and for
// detecting a member's identity change by key bytes rather than the server's identityKey.version.

export const ENCRYPTED_GROUP_NAME = "Encrypted group";

/** A group the server lists is never hidden: without a decrypted name it shows as "Encrypted group" (nameKnown=false). */
export function groupLabel(name: string | undefined): { name: string; nameKnown: boolean } {
  const n = name?.trim();
  return n ? { name: n, nameKnown: true } : { name: ENCRYPTED_GROUP_NAME, nameKnown: false };
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

export type KeyPrint = Record<string, string>; // username -> published identity key bytes (base64)

/** Members whose published identity key bytes differ from what this tab last saw. Version numbers are ignored on purpose. */
export function changedKeys(prev: KeyPrint | undefined, cur: KeyPrint): string[] {
  if (!prev) return [];
  return Object.keys(cur).filter((u) => prev[u] !== undefined && prev[u] !== cur[u]);
}
