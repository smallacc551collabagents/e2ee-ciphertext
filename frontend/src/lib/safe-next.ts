/**
 * ARCH-015: sanitize the post-login `next` redirect. Only same-origin absolute paths
 * matching ^/[^/\\] are accepted; control chars, backslashes and encoded / or \ are rejected.
 */
export const DEFAULT_NEXT = "/chat";

export function safeNext(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return DEFAULT_NEXT;
  if (!/^\/[^/\\]/.test(raw)) return DEFAULT_NEXT;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return DEFAULT_NEXT;
  if (/%(2f|5c|00|0[9ad])/i.test(raw)) return DEFAULT_NEXT;
  try {
    const u = new URL(raw, "http://same.invalid");
    if (u.origin !== "http://same.invalid") return DEFAULT_NEXT;
  } catch {
    return DEFAULT_NEXT;
  }
  return raw;
}
