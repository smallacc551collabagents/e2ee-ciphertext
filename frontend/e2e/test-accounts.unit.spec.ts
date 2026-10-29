import { expect, test } from "@playwright/test";
import { ApiError } from "../src/lib/api/client";
import { TEST_ACCOUNT_USERNAMES, signInOrSignUp } from "../src/lib/test-accounts";

const ok = async (c: { username: string }) => ({ id: c.username });
const fail = (code: string) => async () => { throw new ApiError(401, code, code); };

test("six cards test1..test6", () => expect([...TEST_ACCOUNT_USERNAMES]).toEqual(["test1", "test2", "test3", "test4", "test5", "test6"]));
test("existing account signs in without signup", async () => {
  let up = 0;
  expect(await signInOrSignUp("test1", ok, async (c) => (up++, ok(c)))).toEqual({ id: "test1" });
  expect(up).toBe(0);
});
test("missing account is signed up", async () => {
  expect(await signInOrSignUp("test9", fail("invalid_credentials"), ok)).toEqual({ id: "test9" });
});
test("taken with other password surfaces the login error", async () => {
  await expect(signInOrSignUp("test1", fail("invalid_credentials"), fail("username_taken"))).rejects.toMatchObject({ code: "invalid_credentials" });
});
test("other errors don't trigger signup", async () => {
  let up = 0;
  await expect(signInOrSignUp("test1", fail("rate_limited"), async (c) => (up++, ok(c)))).rejects.toMatchObject({ code: "rate_limited" });
  expect(up).toBe(0);
});
