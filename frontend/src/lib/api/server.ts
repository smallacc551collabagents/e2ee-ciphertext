import "server-only";
import { cookies } from "next/headers";
import { meResponseSchema, type User } from "./schemas";

export const SESSION_COOKIE = "e2ee_session";
const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "https://e2ee-backend.vercel.app").replace(/\/$/, "");

/** Server-side session check against GET /auth/me. Returns null when not signed in. */
export async function getSession(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const res = await fetch(`${API_URL}/auth/me`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) return null;
  const parsed = meResponseSchema.safeParse(await res.json());
  return parsed.success ? parsed.data.user : null;
}
