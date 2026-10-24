export function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}
const COLORS = ["bg-indigo-500", "bg-sky-500", "bg-emerald-500", "bg-amber-500", "bg-red-500", "bg-violet-500"];
export function avatarColor(key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length]!;
}
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
export function listTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return "Yesterday";
  if (now.getTime() - d.getTime() < 7 * 864e5) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString();
}
export function dayLabel(iso: string, now = new Date()): string {
  const l = listTime(iso, now);
  return /^\d\d:\d\d$/.test(l) ? "Today" : l;
}
export const clockTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
