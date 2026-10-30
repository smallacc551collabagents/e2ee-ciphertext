import { test, expect } from "@playwright/test";
import { changedKeys, groupLabel, groupsToWarm, ENCRYPTED_GROUP_NAME } from "../src/features/chat/data/groupMeta";

test("a group without a decrypted name is shown as 'Encrypted group', never hidden", () => {
  expect(groupLabel(undefined)).toEqual({ name: ENCRYPTED_GROUP_NAME, nameKnown: false });
  expect(groupLabel("  ")).toEqual({ name: ENCRYPTED_GROUP_NAME, nameKnown: false });
  expect(groupLabel("G6")).toEqual({ name: "G6", nameKnown: true });
});

test("unnamed groups are fetched in the background (so messages/meta load), throttled per group", () => {
  const tried = new Map<string, number>();
  const known = (id: string) => id === "named";
  expect(groupsToWarm(["named", "g1", "g2"], known, tried, 1000)).toEqual(["g1", "g2"]);
  expect(groupsToWarm(["g1", "g2"], known, tried, 5000)).toEqual([]);
  expect(groupsToWarm(["g1"], known, tried, 17_000)).toEqual(["g1"]);
});

test("identity change is detected by key bytes, not version: same version + new key => changed", () => {
  expect(changedKeys(undefined, { bob: "K1" })).toEqual([]); // first sight is a baseline
  expect(changedKeys({ bob: "K1", carol: "C1" }, { bob: "K1", carol: "C1" })).toEqual([]);
  expect(changedKeys({ bob: "K1", carol: "C1" }, { bob: "K2", carol: "C1" })).toEqual(["bob"]);
  expect(changedKeys({ bob: "K1" }, { bob: "K1", dan: "D1" })).toEqual([]); // new member: membership path handles it
});
