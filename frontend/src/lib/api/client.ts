import { apiErrorSchema, authResponseSchema, type Credentials, type User } from "./schemas";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const FRIENDLY: Record<string, string> = {
  username_taken: "That username is already taken.",
  invalid_credentials: "Invalid username or password.",
  validation_error: "Please check your username and password.",
};

async function post(path: string, body?: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : null,
    });
  } catch {
    throw new ApiError(0, "network_error", "Can't reach the server. Check your connection.");
  }
  if (!res.ok) {
    const parsed = apiErrorSchema.safeParse(await res.json().catch(() => null));
    const code = parsed.success ? parsed.data.error : "unknown_error";
    throw new ApiError(res.status, code, FRIENDLY[code] ?? (parsed.success ? parsed.data.message : "Something went wrong."));
  }
  return res;
}

async function authCall(path: string, creds: Credentials): Promise<User> {
  const res = await post(path, creds);
  const parsed = authResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new ApiError(res.status, "bad_response", "Unexpected server response.");
  return parsed.data.user;
}

/** Creates the account and signs in (server sets the httpOnly cookie). No keys are created here. */
export const signup = (c: Credentials) => authCall("/auth/signup", c);
export const signin = (c: Credentials) => authCall("/auth/signin", c);
export const signout = async (): Promise<void> => {
  await post("/auth/signout");
};
