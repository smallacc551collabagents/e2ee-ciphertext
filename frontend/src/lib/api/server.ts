import "server-only";
import { cookies } from "next/headers";
import { BACKEND_URL, backendAuthHeaders } from "@/lib/backend";
import { meResponseSchema, type User } from "./schemas";

export const SESSION_COOKIE = "e2ee_session";

/** Server-side session check against GET /auth/me. Returns null when not signed in. */
export async function getSession(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const res = await fetch(`${BACKEND_URL}/auth/me`, {
    headers: { ...backendAuthHeaders(), cookie: `${SESSION_COOKIE}=${token}` },
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) return null;
  const parsed = meResponseSchema.safeParse(await res.json());
  return parsed.success ? parsed.data.user : null;
}
