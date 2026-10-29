import { expect, test } from "@playwright/test";
import { ApiError } from "../src/lib/api/client";
import { newChatErrorMessage, validatePeerUsername } from "../src/features/chat/newChat";

test("validatePeerUsername mirrors backend rules", () => {
  expect(validatePeerUsername("", "me_1")).toBe("Enter a username.");
  expect(validatePeerUsername("ab", "me_1")).toMatch(/3–32/);
  expect(validatePeerUsername("a b c", "me_1")).toMatch(/3–32/);
  expect(validatePeerUsername("x".repeat(33), "me_1")).toMatch(/3–32/);
  expect(validatePeerUsername("ME_1", "me_1")).toMatch(/yourself/);
  expect(validatePeerUsername("@bob.smith", "me_1")).toBeNull();
});

test("newChatErrorMessage maps backend errors", () => {
  expect(newChatErrorMessage(new ApiError(404, "not_found", ""), "bob")).toBe("No user named “bob”.");
  expect(newChatErrorMessage(new ApiError(400, "self_conversation", ""), "bob")).toMatch(/yourself/);
  expect(newChatErrorMessage(new ApiError(0, "network_error", ""), "bob")).toMatch(/reach the server/);
  expect(newChatErrorMessage(new Error("x"), "bob")).toMatch(/Try again/);
});
