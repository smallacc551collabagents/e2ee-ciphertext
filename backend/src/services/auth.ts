import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { db, q } from "../database/db.js";

// argon2id via a vetted implementation (OWASP 2024 baseline: m=19MiB, t=2, p=1).
const ARGON = { algorithm: 2 /* Algorithm.Argon2id (const enum) */ as const, memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes

export const USERNAME_RE = "^[a-zA-Z0-9_.]{3,32}$";
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

export const normalizeUsername = (u: string): string => u.trim().toLowerCase();
export const hashPassword = (p: string): Promise<string> => hash(p, ARGON);
// Opaque 256-bit tokens; only SHA-256 digests are persisted (high-entropy => no KDF needed).
export const newToken = (): string => randomBytes(32).toString("base64url");
export const sha256 = (t: string): string => createHash("sha256").update(t).digest("hex");

let dummy: Promise<string> | undefined;
/** Verify password; runs a full argon2 verify even when the user is missing (anti-enumeration). */
export async function verifyPassword(stored: string | undefined, p: string): Promise<boolean> {
  const h = stored ?? (await (dummy ??= hashPassword(newToken())));
  const ok = await verify(h, p).catch(() => false);
  return stored !== undefined && ok;
}

export interface PublicUser { id: string; username: string; createdAt: string }
const toPublic = (r: { id: string; username: string; created_at: Date }): PublicUser => ({
  id: r.id, username: r.username, createdAt: r.created_at.toISOString(),
});

export async function createUser(username: string, password: string): Promise<PublicUser | null> {
  const ph = await hashPassword(password);
  const r = await q().query(
    `INSERT INTO users (id, username, password_hash, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now())
     ON CONFLICT (username) DO NOTHING RETURNING id, username, created_at`,
    [username, ph],
  );
  return r.rows[0] ? toPublic(r.rows[0]) : null;
}

export async function findUserForLogin(username: string) {
  const r = await q().query(
    `SELECT id, username, password_hash, created_at FROM users WHERE username = $1`, [username]);
  return r.rows[0] as { id: string; username: string; password_hash: string; created_at: Date } | undefined;
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await q().query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, $2, $3)`,
    [userId, sha256(token), expiresAt]);
  return { token, expiresAt };
}

export async function userForSession(token: string): Promise<PublicUser | null> {
  const r = await q().query(
    `SELECT u.id, u.username, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha256(token)]);
  return r.rows[0] ? toPublic(r.rows[0]) : null;
}

export async function deleteSession(token: string): Promise<void> {
  await q().query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]);
}

/** Returns the raw reset token if the user exists, else null. Caller must not reveal which. */
export async function createResetToken(username: string): Promise<string | null> {
  const token = newToken();
  const r = await q().query(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
     SELECT gen_random_uuid(), id, $2, $3 FROM users WHERE username = $1 RETURNING id`,
    [username, sha256(token), new Date(Date.now() + RESET_TTL_MS)]);
  return r.rowCount ? token : null;
}

/** Atomically consume a reset token, set the new hash, and revoke all sessions. */
export async function resetPassword(token: string, newPassword: string): Promise<boolean> {
  const ph = await hashPassword(newPassword);
  const c = await db().connect();
  try {
    await c.query("BEGIN");
    const t = await c.query(
      `UPDATE password_reset_tokens SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
      [sha256(token)]);
    const userId = t.rows[0]?.user_id as string | undefined;
    if (!userId) { await c.query("ROLLBACK"); return false; }
    await c.query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [userId, ph]);
    await c.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    // Invalidate any other outstanding reset tokens for this user.
    await c.query(`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
    await c.query("COMMIT");
    return true;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/**
 * E2EE-72: delete an account and everything it owns, in ONE transaction. Returns the attachment
 * refs whose blobs must be removed from object storage (done by the caller, best-effort, after commit).
 */
export async function deleteAccount(c: import("../database/db.js").Queryable, userId: string): Promise<string[]> {
  // Conversations that will have no members left once this user leaves.
  const empty = await c.query<{ id: string }>(
    `SELECT m.conversation_id AS id FROM conversation_members m WHERE m.user_id = $1
       AND NOT EXISTS (SELECT 1 FROM conversation_members o WHERE o.conversation_id = m.conversation_id AND o.user_id <> $1)`, [userId]);
  const emptyIds = empty.rows.map((r) => r.id);
  const atts = await c.query<{ ref: string }>(
    `DELETE FROM attachments WHERE owner_user_id = $1 OR conversation_id = ANY($2::uuid[]) RETURNING ref`, [userId, emptyIds]);
  await c.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  await c.query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [userId]);
  await c.query(`DELETE FROM one_time_prekeys WHERE user_id = $1`, [userId]);
  await c.query(`DELETE FROM identity_keys WHERE user_id = $1`, [userId]);
  await c.query(`DELETE FROM message_deliveries WHERE recipient_id = $1`, [userId]);
  await c.query(`DELETE FROM messages WHERE sender_id = $1`, [userId]);
  await c.query(`DELETE FROM conversation_members WHERE user_id = $1`, [userId]);
  await c.query(`DELETE FROM conversations WHERE id = ANY($1::uuid[])`, [emptyIds]);
  await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
  return atts.rows.map((r) => r.ref);
}
