import { z } from "zod";

// Mirrors backend/src/routes/auth.ts. TODO(Phase 1): move to @e2ee/shared once DTOs are frozen
// (packages/shared currently exports only PROTOCOL_VERSION).
export const USERNAME_RE = /^[a-zA-Z0-9_.]{3,32}$/;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

export const userSchema = z.object({ id: z.string(), username: z.string(), createdAt: z.string() });
export type User = z.infer<typeof userSchema>;

// The session token in auth responses is intentionally NOT parsed: zod strips it,
// so JS never holds it. Auth relies only on the httpOnly cookie.
export const authResponseSchema = z.object({ user: userSchema });
export const meResponseSchema = z.object({ user: userSchema });
export const apiErrorSchema = z.object({ error: z.string(), message: z.string() });

export const credentialsSchema = z.object({
  username: z.string().trim().regex(USERNAME_RE, "3–32 characters: letters, numbers, _ or ."),
  password: z.string().min(PASSWORD_MIN, `At least ${PASSWORD_MIN} characters`).max(PASSWORD_MAX),
});
export type Credentials = z.infer<typeof credentialsSchema>;
