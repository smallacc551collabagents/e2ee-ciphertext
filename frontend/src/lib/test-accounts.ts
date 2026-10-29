// Quick-login test accounts shown above the auth form.
// Enabled only when NEXT_PUBLIC_TEST_ACCOUNTS=1 (set in Vercel). Remove/unset that var to turn it off.
// NOTE: because this is client code, the password below is public to anyone who loads the site.
import { ApiError } from "./api/client";

export const TEST_ACCOUNTS_ENABLED = process.env.NEXT_PUBLIC_TEST_ACCOUNTS === "1";
export const TEST_ACCOUNT_USERNAMES = ["test1", "test2", "test3", "test4", "test5", "test6"] as const;
export const TEST_ACCOUNT_PASSWORD = "passtest1";

type Creds = { username: string; password: string };
type Auth<U> = (c: Creds) => Promise<U>;

/** Sign in; if the account doesn't exist (invalid_credentials), sign it up via the normal flow.
 *  If signup then says username_taken, the account exists with another password -> surface the login error. */
export async function signInOrSignUp<U>(username: string, signin: Auth<U>, signup: Auth<U>, password = TEST_ACCOUNT_PASSWORD): Promise<U> {
  const creds = { username, password };
  try {
    return await signin(creds);
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== "invalid_credentials") throw err;
    try {
      return await signup(creds);
    } catch (e2) {
      if (e2 instanceof ApiError && e2.code === "username_taken") throw err;
      throw e2;
    }
  }
}
