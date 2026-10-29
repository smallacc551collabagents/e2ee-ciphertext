import { expect, test } from "@playwright/test";
import { addCandidates, groupErrorMessage, systemLine } from "../src/features/chat/groupCopy";
import { ackPrefix, decodeGroupMeta, encodeGroupMeta } from "../src/features/chat/data/live";

const ev = (type: "group_created" | "member_added" | "member_removed" | "member_left" | "admin_changed", actor: string | null, target: string | null) =>
  ({ type, actor, actorUsername: actor ? `${actor}_name` : null, target, targetUsername: target ? `${target}_name` : null, membershipVersion: 2 });

test("systemLine renders membership events, 'You' for me", () => {
  expect(systemLine(ev("member_added", "a", "b"), "z")).toBe("a_name added b_name");
  expect(systemLine(ev("member_added", "a", "z"), "z")).toBe("a_name added you");
  expect(systemLine(ev("member_removed", "z", "b"), "z")).toBe("You removed b_name");
  expect(systemLine(ev("member_left", "b", null), "z")).toBe("b_name left");
  expect(systemLine(ev("group_created", "a", null), "z")).toBe("a_name created the group");
  expect(systemLine(ev("admin_changed", null, "z"), "z")).toBe("You are now the admin");
});

test("addCandidates only offers 1:1 peers not already in the group", () => {
  expect(addCandidates(["bob", "carol", "dave", "bob"], [{ username: "Carol" }], "")).toEqual(["bob", "dave"]);
  expect(addCandidates(["bob", "dave"], [], "@da")).toEqual(["dave"]);
});

test("groupErrorMessage maps backend codes", () => {
  expect(groupErrorMessage({ code: "cannot_remove_admin" })).toMatch(/admin/);
  expect(groupErrorMessage({ code: "not_a_contact" })).toMatch(/1:1/);
  expect(groupErrorMessage({ code: "group_full" })).toMatch(/50/);
});

test("group meta round-trips and ignores normal text", () => {
  expect(decodeGroupMeta(encodeGroupMeta("Team"))).toEqual({ name: "Team" });
  expect(decodeGroupMeta("hello")).toBeNull();
  expect(decodeGroupMeta('{"t":"other","name":"x"}')).toBeNull();
});

test("ackPrefix stops at the first failure", () => {
  expect(ackPrefix([{ id: "a", ok: true }, { id: "b", ok: false }, { id: "c", ok: true }])).toEqual(["a"]);
  expect(ackPrefix([{ id: "a", ok: true }, { id: "b", ok: true }])).toEqual(["a", "b"]);
});
