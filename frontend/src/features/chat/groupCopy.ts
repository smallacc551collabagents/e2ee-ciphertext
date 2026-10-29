import type { SystemEventWire } from "@e2ee/shared";

export const GROUP_MAX_MEMBERS = 50;

/** "alice added bob" style lines for server membership events. `me` renders as "You". */
export function systemLine(e: SystemEventWire, meId: string): string {
  const who = (id: string | null, name?: string | null) => (id && id === meId ? "You" : name ?? "Someone");
  const a = who(e.actor, e.actorUsername), t = who(e.target, e.targetUsername);
  const obj = t === "You" ? "you" : t;
  switch (e.type) {
    case "group_created": return `${a} created the group`;
    case "member_added": return `${a} added ${obj}`;
    case "member_removed": return `${a} removed ${obj}`;
    case "member_left": return `${a} left`;
    case "admin_changed": return `${t} ${t === "You" ? "are" : "is"} now the admin`;
  }
}

/** Candidates to add: 1:1 peers that aren't already members, filtered by query. */
export function addCandidates(contacts: readonly string[], members: readonly { username: string }[], query: string): string[] {
  const inGroup = new Set(members.map((m) => m.username.toLowerCase()));
  const q = query.trim().toLowerCase().replace(/^@/, "");
  return [...new Set(contacts)].filter((u) => !inGroup.has(u.toLowerCase()) && u.toLowerCase().includes(q)).sort();
}

export function groupErrorMessage(e: unknown): string {
  const code = (e as { code?: string }).code;
  switch (code) {
    case "cannot_remove_admin": return "The group admin can’t be removed.";
    case "not_a_contact": return "You can only add people you already have a 1:1 chat with.";
    case "group_full": return `Groups are limited to ${GROUP_MAX_MEMBERS} members.`;
    case "already_member": return "That person is already in the group.";
    case "not_member": return "That person isn’t in the group anymore.";
    case "network_error": return "Can’t reach the server. Check your connection and try again.";
    default: return "Something went wrong. Please try again.";
  }
}
