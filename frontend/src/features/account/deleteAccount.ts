import { deleteAccountRequestSchema } from "@e2ee/shared";

export type DeleteResult = { ok: true } | { ok: false; message: string };
type Deps = { fetch: typeof fetch; wipe: () => Promise<void> };

/** E2EE-72: DELETE /api/auth/me {password}; only on 204 wipe local crypto state (deleteLocalCryptoState per store). */
export async function deleteAccount(password: string, deps: Deps): Promise<DeleteResult> {
  const body = deleteAccountRequestSchema.safeParse({ password });
  if (!body.success) return { ok: false, message: "Enter your password." };
  let res: Response;
  try {
    res = await deps.fetch("/api/auth/me", { method: "DELETE", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body.data) });
  } catch { return { ok: false, message: "Can’t reach the server. Try again." }; }
  if (res.status === 204) { await deps.wipe().catch(() => undefined); return { ok: true }; }
  if (res.status === 401) return { ok: false, message: "Password is incorrect." };
  if (res.status === 429) return { ok: false, message: "Too many attempts. Try again later." };
  return { ok: false, message: "Couldn’t delete your account. Try again." };
}
