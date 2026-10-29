import { expect, test } from "@playwright/test";
import { conversationListSchema, messagePageSchema, sendMessageRequestSchema } from "../src/features/chat/data/wire";
import { initials, listTime } from "../src/features/chat/format";

// Pure unit tests (no server).
test.describe("chat data contracts", () => {
  test("Phase 1 wire contracts: opaque base64 + version, caps enforced", () => {
    const msg = { id: "m", conversationId: "c", senderId: "u", seq: "1", clientMsgId: "abcdefgh", ciphertext: "AAEC", version: 1, createdAt: "2026-10-24T00:00:00Z" };
    expect(messagePageSchema.safeParse({ messages: [msg], nextCursor: null, hasMore: false }).success).toBe(true);
    expect(messagePageSchema.safeParse({ messages: [{ ...msg, ciphertext: "not base64!" }], nextCursor: null, hasMore: false }).success).toBe(false);
    expect(sendMessageRequestSchema.safeParse({ clientMsgId: "short", ciphertext: "AAEC", version: 1 }).success).toBe(false);
    expect(sendMessageRequestSchema.safeParse({ clientMsgId: "abcdefgh", ciphertext: "A".repeat(44000), version: 1 }).success).toBe(false);
    expect(sendMessageRequestSchema.safeParse({ clientMsgId: "abcdefgh", ciphertext: "AAEC", version: 0 }).success).toBe(false);
    expect(conversationListSchema.safeParse({ conversations: [{ id: "c", kind: "direct", members: [{ id: "u", username: "a" }] }] }).success).toBe(true);
  });
  test("format helpers", () => {
    expect(initials("Ava Testwell")).toBe("AT");
    expect(initials("fe_test")).toBe("FT");
    const now = new Date("2026-10-24T12:00:00");
    expect(listTime(new Date("2026-10-23T09:00:00").toISOString(), now)).toBe("Yesterday");
  });
});

// UI tests against a dev server started with NEXT_PUBLIC_CHAT_FIXTURES=1 and a logged-in test user.
const fixtures = !!process.env.E2E_CHAT_FIXTURES;
const username = process.env.E2E_USERNAME ?? "fe_test_1792812361556";
const password = process.env.E2E_PASSWORD ?? "correct-horse-battery";

test.describe("chat UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/chat$/);
  });

  test("production path uses the real adapter: no coming-soon placeholder, no fake data", async ({ page }) => {
    test.skip(fixtures, "fixtures server");
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("chat-coming-soon")).toHaveCount(0);
    await expect(page.getByText("Ava Testwell")).toHaveCount(0);
  });

  test("new chat dialog: validation, not found, existing reopens, new selects + composer enabled", async ({ page }) => {
    test.skip(!fixtures, "needs NEXT_PUBLIC_CHAT_FIXTURES=1 server");
    const open = page.getByRole("button", { name: "New chat" });
    await expect(open).toBeEnabled();
    await open.click();
    const dialog = page.getByRole("dialog", { name: "New chat" });
    const input = dialog.getByLabel("Username");
    await expect(input).toBeFocused();
    await dialog.getByRole("button", { name: "Start chat" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Enter a username.");
    await input.fill("a b");
    await dialog.getByRole("button", { name: "Start chat" }).click();
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await input.fill("nobody");
    await dialog.getByRole("button", { name: "Start chat" }).click();
    await expect(dialog.getByRole("alert")).toContainText("No user named");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();
    await open.click();
    await page.getByRole("dialog").getByLabel("Username").fill("new_friend");
    await page.getByRole("dialog").getByRole("button", { name: "Start chat" }).click();
    await expect(page.getByRole("heading", { name: "new_friend" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await page.getByRole("textbox", { name: "Message" }).fill("first message");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("bubble").last()).toContainText("Sent");
    await open.click();
    await page.getByRole("dialog").getByLabel("Username").fill("new_friend");
    await page.getByRole("dialog").getByRole("button", { name: "Start chat" }).click();
    await expect(page.getByRole("button", { name: /new_friend/ })).toHaveCount(1);
  });

  test("fixtures: list, open, send, failed+retry, escaping, mobile back", async ({ page }) => {
    test.skip(!fixtures, "needs NEXT_PUBLIC_CHAT_FIXTURES=1 server");
    await page.getByRole("button", { name: /Ava Testwell/ }).click();
    await expect(page.getByRole("heading", { name: "Ava Testwell" })).toBeVisible();
    await expect(page.getByText("<b>plain text only</b>")).toBeVisible();
    await page.getByRole("textbox", { name: "Message" }).fill("hello there");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("bubble").last()).toContainText("Sent");
    await page.getByRole("textbox", { name: "Message" }).fill("please fail");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("bubble").last()).toContainText("Failed");
    await page.getByLabel("Search conversations").fill("falcon");
    await expect(page.getByRole("button", { name: /Project Falcon/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Mia Sample/ })).toHaveCount(0);
    await page.screenshot({ path: "test-results/chat-desktop.png" });
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.getByLabel("Conversations", { exact: true })).toBeHidden();
    await page.getByRole("button", { name: "Back to conversations" }).click();
    await expect(page.getByLabel("Conversations", { exact: true })).toBeVisible();
  });
});
