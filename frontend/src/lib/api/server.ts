import "server-only";
import { cookies, headers } from "next/headers";
import { BACKEND_URL, backendAuthHeaders } from "@/lib/backend";
import { meResponseSchema, type User } from "./schemas";

export const SESSION_COOKIE = "e2ee_session";

/**
 * E2EE-73 / ARCH-018: distinguish "not signed in" from "backend unavailable" so a 5xx or
 * network failure renders an error state instead of bouncing between /login and /chat.
 */
export type SessionResult =
  | { status: "authenticated"; user: User }
  | { status: "anonymous" }
  | { status: "unavailable" };

export async function getSessionResult(): Promise<SessionResult> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return { status: "anonymous" };
  const res = await fetch(`${BACKEND_URL}/auth/me`, {
    headers: { ...backendAuthHeaders(await headers()), cookie: `${SESSION_COOKIE}=${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!res) return { status: "unavailable" };
  if (res.status === 401 || res.status === 403) return { status: "anonymous" };
  if (!res.ok) return { status: "unavailable" };
  const parsed = meResponseSchema.safeParse(await res.json().catch(() => null));
  return parsed.success ? { status: "authenticated", user: parsed.data.user } : { status: "unavailable" };
}

/** Server-side session check against GET /auth/me. Returns null when not signed in or unknown. */
export async function getSession(): Promise<User | null> {
  const r = await getSessionResult();
  return r.status === "authenticated" ? r.user : null;
}
