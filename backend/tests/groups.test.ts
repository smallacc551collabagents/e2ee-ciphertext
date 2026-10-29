// Group chat (Phase 6): real migrations on PGlite + real Fastify app.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { setTestDb, type Queryable } from "../src/database/db.js";
import { buildApp } from "../src/app.js";
import { sweepMessages } from "../src/services/retention.js";

const pg = new PGlite();
const wrap = (c: PGlite | Transaction): Queryable => ({
  async query(text: string, values?: unknown[]) {
    const r = await c.query(text, values as never[]);
    return { rows: r.rows as never[], rowCount: Math.max(r.affectedRows ?? 0, r.rows.length) };
  },
});
let app: FastifyInstance;
before(async () => {
  const dir = join(import.meta.dirname, "../prisma/migrations");
  for (const m of readdirSync(dir).filter((d) => /^\d/.test(d)).sort()) await pg.exec(readFileSync(join(dir, m, "migration.sql"), "utf8"));
  setTestDb({ ...wrap(pg), tx: (fn) => pg.transaction((t) => fn(wrap(t))) });
  process.env.LOG_LEVEL = "silent";
  app = buildApp();
  await app.ready();
});
after(async () => { await app.close(); await pg.close(); });

const b64 = (n: number, fill = 7) => Buffer.alloc(n, fill).toString("base64");
async function signup(username: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/auth/signup", payload: { username, password: "correct-horse-battery" } });
  assert.equal(r.statusCode, 201);
  return `e2ee_session=${r.cookies.find((x) => x.name === "e2ee_session")?.value}`;
}
const call = (cookie: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, ...(payload ? { payload } : {}), headers: { cookie } });
const publish = (cookie: string, fill: number, otk = 1) => call(cookie, "POST", "/keys/publish", {
  identityKey: { publicKey: b64(33, fill), version: 1 },
  signedPrekey: { keyId: 1, publicKey: b64(33, fill), signature: b64(64), version: 1 },
  oneTimePrekeys: [{ keyId: otk, publicKey: b64(33, otk), version: 1 }],
});
type Msg = { id: string; seq: string; clientMsgId: string; ciphertext: string; kind?: string; event?: { type: string; target: string | null; targetUsername?: string } };
const msgs = async (c: string, conv: string) => (await call(c, "GET", `/conversations/${conv}/messages`)).json().messages as Msg[];
const userMsgs = async (c: string, conv: string) => (await msgs(c, conv)).filter((m) => m.kind !== "system");
const ack = (c: string, ids: string[]) => call(c, "POST", "/messages/ack", { messageIds: ids });
const gsend = (c: string, g: string, id: string, membershipVersion: number, fill = 40) =>
  call(c, "POST", `/conversations/${g}/messages`, { clientMsgId: id, ciphertext: b64(40, fill), version: 1, membershipVersion });
const ver = async (c: string, g: string) => ((await call(c, "GET", "/conversations")).json().conversations.find((x: { id: string }) => x.id === g)?.membershipVersion) as number;

const U: Record<string, string> = {};
const ids: Record<string, string> = {};
const dm = async (x: string, y: string) => assert.ok((await call(U[x]!, "POST", "/conversations", { username: y })).statusCode < 300);

test("setup: users + 1:1 contacts of alice", async () => {
  for (const [i, n] of ["galice", "gbob", "gcarol", "gdave", "geve", "gfrank"].entries()) {
    U[n] = await signup(n);
    assert.equal((await publish(U[n]!, i + 1)).statusCode, 200);
    ids[n] = (await call(U[n]!, "GET", "/auth/me")).json().user?.id ?? (await call(U[n]!, "GET", "/auth/me")).json().id;
  }
  for (const n of ["gbob", "gcarol", "gdave", "gfrank"]) await dm("galice", n);
});

let g = "";
test("create group: admin = creator, version 1, group_created event; not_a_contact 403", async () => {
  const bad = await call(U.galice!, "POST", "/groups", { members: ["gbob", "geve"] });
  assert.equal(bad.statusCode, 403); assert.equal(bad.json().error, "not_a_contact"); assert.deepEqual(bad.json().usernames, ["geve"]);
  const r = await call(U.galice!, "POST", "/groups", { members: ["gbob", "gcarol"], encryptedMeta: b64(30) });
  assert.equal(r.statusCode, 201);
  const c = r.json().conversation;
  g = c.id;
  assert.equal(c.kind, "group"); assert.equal(c.adminId, ids.galice); assert.equal(c.membershipVersion, 1);
  assert.equal(c.members.length, 3); assert.equal(c.encryptedMeta, b64(30));
  const ev = await msgs(U.gbob!, g);
  assert.equal(ev[0]?.kind, "system"); assert.equal(ev[0]?.event?.type, "group_created");
  const list = (await call(U.gbob!, "GET", "/conversations")).json().conversations.find((x: { id: string }) => x.id === g);
  assert.equal(list.adminId, ids.galice); assert.equal(list.membershipVersion, 1);
});

test("non-member 404 on everything", async () => {
  assert.equal((await call(U.geve!, "GET", `/conversations/${g}/messages`)).statusCode, 404);
  assert.equal((await gsend(U.geve!, g, "x-eve-0001", 1)).statusCode, 404);
  assert.equal((await call(U.geve!, "POST", `/groups/${g}/members`, { usernames: ["geve"] })).statusCode, 404);
  assert.equal((await call(U.geve!, "POST", `/groups/${g}/leave`)).statusCode, 404);
  assert.equal((await call(U.geve!, "DELETE", `/groups/${g}/members/gbob`)).statusCode, 404);
});

test("stale membershipVersion -> 409 membership_changed with current members; missing -> 409", async () => {
  const r = await gsend(U.galice!, g, "m-stale-001", 0);
  assert.equal(r.statusCode, 409); assert.equal(r.json().error, "membership_changed");
  assert.equal(r.json().membershipVersion, 1); assert.equal(r.json().members.length, 3);
  assert.equal((await call(U.galice!, "POST", `/conversations/${g}/messages`, { clientMsgId: "m-nover-01", ciphertext: b64(40), version: 1 })).statusCode, 409);
});

test("offline member gets every queued message in order (fan-out, ack-delete)", async () => {
  const sent: string[] = [];
  for (let i = 0; i < 5; i++) {
    const who = i % 2 ? U.gbob! : U.galice!;
    const r = await gsend(who, g, `m-off-000${i}`, 1, 50 + i);
    assert.equal(r.statusCode, 201); sent.push(r.json().message.seq);
  }
  const cm = await userMsgs(U.gcarol!, g); // carol was "offline"
  assert.deepEqual(cm.map((m) => m.seq), sent);
  assert.deepEqual(cm.map((m) => m.ciphertext), [0, 1, 2, 3, 4].map((i) => b64(40, 50 + i)));
  // single Megolm ciphertext fanned out: one delivery per member except sender
  const d = await pg.query<{ n: number }>(`SELECT count(*)::int n FROM message_deliveries d JOIN messages m ON m.id=d.message_id WHERE m.client_msg_id='m-off-0000'`);
  assert.equal(d.rows[0]?.n, 2);
});

test("cannot remove admin (403); adder must have a 1:1 (bob has none with dave)", async () => {
  const r = await call(U.gbob!, "DELETE", `/groups/${g}/members/galice`);
  assert.equal(r.statusCode, 403); assert.equal(r.json().error, "cannot_remove_admin");
  const n = await call(U.gbob!, "POST", `/groups/${g}/members`, { usernames: ["gdave"] });
  assert.equal(n.statusCode, 403); assert.equal(n.json().error, "not_a_contact");
  assert.equal((await call(U.galice!, "POST", `/groups/${g}/members`, { usernames: ["gbob"] })).json().error, "already_member");
});

test("new member sees no history; removed member gets nothing new and can't send/fetch", async () => {
  const add = await call(U.galice!, "POST", `/groups/${g}/members`, { usernames: ["gdave"] });
  assert.equal(add.statusCode, 200); assert.equal(add.json().conversation.membershipVersion, 2);
  const dm0 = await msgs(U.gdave!, g);
  assert.equal(dm0.length, 1); assert.equal(dm0[0]?.event?.type, "member_added"); // only own join line
  assert.equal((await gsend(U.galice!, g, "m-old-ver-1", 1)).statusCode, 409);
  assert.equal((await gsend(U.galice!, g, "m-after-add", 2)).statusCode, 201);
  assert.equal((await userMsgs(U.gdave!, g)).length, 1);
  // bob (non-admin member) removes carol
  const rm = await call(U.gbob!, "DELETE", `/groups/${g}/members/gcarol`);
  assert.equal(rm.statusCode, 200); assert.equal(rm.json().conversation.membershipVersion, 3);
  assert.equal((await call(U.gcarol!, "GET", `/conversations/${g}/messages`)).statusCode, 404);
  assert.equal((await gsend(U.gcarol!, g, "m-carol-x1", 3)).statusCode, 404);
  assert.equal((await gsend(U.galice!, g, "m-post-rm1", 3)).statusCode, 201);
  const q2 = await pg.query(`SELECT 1 FROM message_deliveries WHERE recipient_id = $1`, [ids.gcarol]);
  assert.equal(q2.rows.length, 0);
  const ev = (await msgs(U.galice!, g)).filter((m) => m.kind === "system").map((m) => m.event?.type);
  assert.ok(ev.includes("member_removed"));
});

test("concurrent membership changes serialize: distinct version bumps", async () => {
  await dm("galice", "geve");
  const v0 = await ver(U.galice!, g);
  const rs = await Promise.all([
    call(U.galice!, "POST", `/groups/${g}/members`, { usernames: ["geve"] }),
    call(U.galice!, "DELETE", `/groups/${g}/members/gdave`),
    call(U.galice!, "POST", `/groups/${g}/members`, { usernames: ["gcarol"] }),
  ]);
  assert.deepEqual(rs.map((r) => r.statusCode), [200, 200, 200]);
  const vs = rs.map((r) => r.json().conversation.membershipVersion).sort();
  assert.equal(new Set(vs).size, 3);
  assert.equal(await ver(U.galice!, g), v0 + 3);
  const evs = (await msgs(U.galice!, g)).filter((m) => m.kind === "system");
  const seqs = evs.map((m) => Number(m.seq));
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
});

test("leave + re-add: fresh joined_at, no history from first stint or gap", async () => {
  // carol was re-added above; she now leaves and is re-added again
  assert.equal((await call(U.gcarol!, "POST", `/groups/${g}/leave`)).statusCode, 200);
  const v = await ver(U.galice!, g);
  assert.equal((await gsend(U.galice!, g, "m-gap-0001", v)).statusCode, 201);
  assert.equal((await call(U.galice!, "POST", `/groups/${g}/members`, { usernames: ["gcarol"] })).statusCode, 200);
  assert.equal((await userMsgs(U.gcarol!, g)).length, 0);
});

test("identity change in group flags & resend in place", async () => {
  const v = await ver(U.galice!, g);
  const s = await gsend(U.galice!, g, "m-idc-0001", v, 61);
  assert.equal(s.statusCode, 201);
  assert.equal((await publish(U.gcarol!, 99, 7)).statusCode, 200); // carol: new device
  assert.equal((await userMsgs(U.gcarol!, g)).length, 0);
  const u = (await call(U.galice!, "GET", `/conversations/${g}/undeliverable`)).json().undeliverable;
  assert.equal(u.length, 1); assert.equal(u[0].recipientId, ids.gcarol);
  // system events are not flagged (plaintext membership lines stay visible)
  assert.ok((await msgs(U.gcarol!, g)).some((m) => m.kind === "system"));
  const r = await gsend(U.galice!, g, "m-idc-0001", v, 62);
  assert.equal(r.statusCode, 200); assert.equal(r.json().duplicate, false); assert.equal(r.json().message.seq, s.json().message.seq);
  const cm = await userMsgs(U.gcarol!, g);
  assert.equal(cm.length, 1); assert.equal(cm[0]?.ciphertext, b64(40, 62));
});

test("to-device: shared-conversation only, queued, acked, dropped on identity change", async () => {
  const ok = await call(U.galice!, "POST", "/to-device", { messages: [{ recipient: "gcarol", ciphertext: b64(80), type: 0, version: 1 }, { recipient: "gbob", ciphertext: b64(80, 3), type: 1, version: 1 }] });
  assert.equal(ok.statusCode, 201); assert.equal(ok.json().sent, 2);
  const stranger = await signup("gstranger");
  const bad = await call(stranger, "POST", "/to-device", { messages: [{ recipient: "galice", ciphertext: b64(80), type: 0, version: 1 }] });
  assert.equal(bad.statusCode, 403); assert.equal(bad.json().error, "not_a_contact");
  const got = (await call(U.gbob!, "GET", "/to-device")).json();
  assert.equal(got.messages.length, 1); assert.equal(got.messages[0].senderUsername, "galice"); assert.equal(got.messages[0].type, 1);
  assert.equal((await call(U.gcarol!, "POST", "/to-device/ack", { ids: [got.messages[0].id] })).json().acked, 0); // not hers
  assert.equal((await call(U.gbob!, "POST", "/to-device/ack", { ids: [got.messages[0].id] })).json().acked, 1);
  assert.equal((await call(U.gbob!, "GET", "/to-device")).json().messages.length, 0);
  assert.equal((await publish(U.gcarol!, 100, 8)).statusCode, 200);
  assert.equal((await call(U.gcarol!, "GET", "/to-device")).json().messages.length, 0);
});

test("group_full at 50", async () => {
  const big = await call(U.galice!, "POST", "/groups", { members: ["gbob"] });
  const gid = big.json().conversation.id;
  const vals: string[] = [];
  for (let i = 0; i < 49; i++) vals.push(`('00000000-0000-4000-8000-${String(i).padStart(12, "0")}', 'gfill${i}', 'x', now())`);
  await pg.exec(`INSERT INTO users (id, username, password_hash, updated_at) VALUES ${vals.join(",")}`);
  await pg.exec(`INSERT INTO conversation_members (conversation_id, user_id) SELECT '${gid}', id FROM users WHERE username LIKE 'gfill%' AND username <> 'gfill0'`);
  // now 2 + 48 = 50
  const r = await call(U.galice!, "POST", `/groups/${gid}/members`, { usernames: ["gfrank"] });
  assert.equal(r.statusCode, 409); assert.equal(r.json().error, "group_full");
});

test("admin leave transfers to oldest member; last leave deletes group", async () => {
  const r = await call(U.galice!, "POST", "/groups", { members: ["gbob", "gfrank"] });
  const gid = r.json().conversation.id;
  assert.equal((await gsend(U.galice!, gid, "m-adm-0001", 1)).statusCode, 201);
  assert.equal((await call(U.galice!, "POST", `/groups/${gid}/leave`)).statusCode, 200);
  const c = (await call(U.gbob!, "GET", "/conversations")).json().conversations.find((x: { id: string }) => x.id === gid);
  assert.ok([ids.gbob, ids.gfrank].includes(c.adminId));
  assert.ok((await msgs(U.gbob!, gid)).some((m) => m.event?.type === "admin_changed"));
  assert.equal((await call(U.gbob!, "POST", `/groups/${gid}/leave`)).statusCode, 200);
  const last = await call(U.gfrank!, "POST", `/groups/${gid}/leave`);
  assert.equal(last.json().groupDeleted, true);
  assert.equal((await pg.query(`SELECT 1 FROM conversations WHERE id = $1`, [gid])).rows.length, 0);
  assert.equal((await pg.query(`SELECT 1 FROM messages WHERE conversation_id = $1`, [gid])).rows.length, 0);
});

test("account delete in group: admin transfers, member removed, to-device gone", async () => {
  const r = await call(U.galice!, "POST", "/groups", { members: ["gbob", "gfrank"] });
  const gid = r.json().conversation.id;
  await call(U.galice!, "POST", "/to-device", { messages: [{ recipient: "gbob", ciphertext: b64(80), type: 0, version: 1 }] });
  const d = await call(U.galice!, "DELETE", "/auth/me", { password: "correct-horse-battery" });
  assert.ok(d.statusCode < 300, String(d.statusCode));
  const c = (await call(U.gbob!, "GET", "/conversations")).json().conversations.find((x: { id: string }) => x.id === gid);
  assert.equal(c.members.length, 2); assert.ok([ids.gbob, ids.gfrank].includes(c.adminId)); assert.equal(c.membershipVersion, 3);
  assert.equal((await call(U.gbob!, "GET", "/to-device")).json().messages.length, 0);
  assert.equal((await pg.query(`SELECT 1 FROM conversation_members WHERE user_id = $1`, [ids.galice])).rows.length, 0);
});

test("retention: acked group messages deleted once all members ack; to-device expires at 30 days", async () => {
  const r = await call(U.gbob!, "POST", "/groups", { members: [] as string[] }).catch(() => null);
  assert.ok(r); // empty member list rejected by schema
  assert.equal(r.statusCode, 400);
  const fr = await signup("gfr2"); await publish(fr, 50);
  assert.ok((await call(U.gbob!, "POST", "/conversations", { username: "gfr2" })).statusCode < 300);
  const gid = (await call(U.gbob!, "POST", "/groups", { members: ["gfr2"] })).json().conversation.id;
  const s = await gsend(U.gbob!, gid, "m-ret-0001", 1);
  assert.equal(s.statusCode, 201);
  const all = await msgs(fr, gid);
  assert.equal((await ack(fr, all.map((m) => m.id))).statusCode, 200);
  assert.equal((await pg.query(`SELECT 1 FROM messages WHERE id = $1`, [s.json().message.id])).rows.length, 0);
  await call(U.gbob!, "POST", "/to-device", { messages: [{ recipient: "gfr2", ciphertext: b64(80), type: 0, version: 1 }] });
  await pg.query(`UPDATE to_device_messages SET created_at = now() - interval '31 days'`);
  assert.equal((await call(fr, "GET", "/to-device")).json().messages.length, 0);
  await sweepMessages();
  assert.equal((await pg.query(`SELECT 1 FROM to_device_messages`)).rows.length, 0);
});
