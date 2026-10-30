import { test, expect } from "@playwright/test";
import { groupLabel, groupsToWarm, ENCRYPTED_GROUP_NAME } from "../src/features/chat/data/groupMeta";

test("group label: decrypted name, else member names, else 'Encrypted group' (never throws, never hidden)", () => {
  expect(groupLabel("G6", () => ["bob"])).toEqual({ name: "G6", nameKnown: true });
  expect(groupLabel(undefined, () => ["bob", "carol"])).toEqual({ name: "bob, carol", nameKnown: true });
  expect(groupLabel(undefined, () => [])).toEqual({ name: ENCRYPTED_GROUP_NAME, nameKnown: false });
  expect(groupLabel(undefined, () => { throw new Error("lookup failed"); })).toEqual({ name: ENCRYPTED_GROUP_NAME, nameKnown: false });
  expect(groupLabel("  ")).toEqual({ name: ENCRYPTED_GROUP_NAME, nameKnown: false });
  const rows = [() => ["a"], (): string[] => { throw new Error("x"); }, () => ["c"]].map((m) => groupLabel(undefined, m).name);
  expect(rows).toEqual(["a", ENCRYPTED_GROUP_NAME, "c"]); // one bad group can't drop the others
});

test("unnamed groups are fetched in the background (so messages/meta load), throttled per group", () => {
  const tried = new Map<string, number>();
  const known = (id: string) => id === "named";
  expect(groupsToWarm(["named", "g1", "g2"], known, tried, 1000)).toEqual(["g1", "g2"]);
  expect(groupsToWarm(["g1", "g2"], known, tried, 5000)).toEqual([]);
  expect(groupsToWarm(["g1"], known, tried, 17_000)).toEqual(["g1"]);
});
