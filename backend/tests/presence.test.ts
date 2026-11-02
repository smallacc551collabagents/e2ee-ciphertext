// Last seen + privacy + delivered watermark: real migrations on PGlite + real Fastify app.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { setTestDb, type Queryable } from "../src/database/db.js";
import { buildApp } from "../src/app.js";
import { SYNC } from "../src/routes/sync.js";
import { PRESENCE } from "../src/services/presence.js";
import { conversationListSchema, syncWaitResponseSchema } from "@e2ee/shared";

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
  SYNC.pollMs = 200;
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
const call = (cookie: string, method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
  app.inject({ method, url, ...(payload ? { payload } : {}), headers: { cookie } });
const publish = (cookie: string, fill: number) => call(cookie, "POST", "/keys/publish", {
  identityKey: { publicKey: b64(33, fill), version: 1 },
  signedPrekey: { keyId: 1, publicKey: b64(33, fill), signature: b64(64), version: 1 },
  oneTimePrekeys: [{ keyId: 1, publicKey: b64(33, 1), version: 1 }],
});
const wait = async (c: string, q = "") => {
  const r = await call(c, "GET", `/sync/wait${q}`);
  assert.equal(r.statusCode, 200, r.body);
  return syncWaitResponseSchema.parse(r.json());
};
const send = (c: string, conv: string, id: string) =>
  call(c, "POST", `/conversations/${conv}/messages`, { clientMsgId: id, ciphertext: b64(40), version: 1 });


const uid = async (c: string) => (await call(c, "GET", "/auth/me")).json().user.id as string;
const lastSeen = async (id: string) => (await pg.query<{ t: Date | null }>(`SELECT last_seen_at AS t FROM users WHERE id = $1`, [id])).rows[0]!.t;
const convs = async (c: string) => conversationListSchema.parse((await call(c, "GET", "/conversations")).json()).conversations;
const member = async (viewer: string, conv: string, id: string) => (await convs(viewer)).find((x) => x.id === conv)!.members.find((m) => m.id === id)!;

let A = "", B = "", X = "", aId = "", bId = "", xId = "", conv = "";
test("setup", async () => {
  A = await signup("presalice"); B = await signup("presbob"); X = await signup("presstranger");
  for (const [i, c] of [A, B, X].entries()) assert.equal((await publish(c, i + 1)).statusCode, 200);
  aId = await uid(A); bId = await uid(B); xId = await uid(X);
  const r = await call(A, "POST", "/conversations", { username: "presbob" });
  conv = r.json().conversation.id;
});

test("heartbeat 204 + auth required", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/presence/heartbeat" })).statusCode, 401);
  assert.equal((await call(A, "POST", "/presence/heartbeat")).statusCode, 204);
  assert.ok(await lastSeen(aId));
});

test("last_seen throttled to one write per 30s", async () => {
  await pg.query(`UPDATE users SET last_seen_at = now() - interval '10 seconds' WHERE id = $1`, [aId]);
  const t0 = await lastSeen(aId);
  await call(A, "POST", "/presence/heartbeat"); await call(A, "GET", "/conversations");
  assert.equal((await lastSeen(aId))!.getTime(), t0!.getTime(), "within 30s: no write");
  await pg.query(`UPDATE users SET last_seen_at = now() - interval '${PRESENCE.throttleSeconds + 5} seconds' WHERE id = $1`, [aId]);
  const t1 = await lastSeen(aId);
  await call(A, "GET", "/sync/wait"); // sync/wait counts as activity
  assert.ok((await lastSeen(aId))!.getTime() > t1!.getTime());
});

test("presence in /conversations: online within 60s, lastSeenAt otherwise; none for self", async () => {
  await call(B, "POST", "/presence/heartbeat");
  let m = await member(A, conv, bId);
  assert.equal(m.presence?.online, true);
  assert.ok(m.presence?.lastSeenAt);
  await pg.query(`UPDATE users SET last_seen_at = now() - interval '5 minutes' WHERE id = $1`, [bId]);
  m = await member(A, conv, bId);
  assert.equal(m.presence?.online, false);
  assert.ok(m.presence?.lastSeenAt);
  assert.equal((await member(A, conv, aId)).presence, null);
});

test("privacy: reciprocal hide", async () => {
  assert.equal((await call(B, "PUT", "/me/privacy", { hideLastSeen: "yes" })).statusCode, 400);
  const r = await call(B, "PUT", "/me/privacy", { hideLastSeen: true });
  assert.equal(r.statusCode, 200); assert.deepEqual(r.json(), { hideLastSeen: true });
  assert.equal((await call(B, "GET", "/auth/me")).json().user.hideLastSeen, true);
  assert.equal((await member(A, conv, bId)).presence, null, "target hides => null");
  assert.equal((await member(B, conv, aId)).presence, null, "viewer hides => sees nobody");
  await call(B, "PUT", "/me/privacy", { hideLastSeen: false });
  assert.notEqual((await member(A, conv, bId)).presence, null);
  assert.notEqual((await member(B, conv, aId)).presence, null);
});

test("non-contact cannot see presence", async () => {
  await call(A, "POST", "/presence/heartbeat");
  const all = (await convs(X)).flatMap((c) => c.members.map((m) => m.id));
  assert.ok(!all.includes(aId) && !all.includes(bId));
  assert.equal((await call(X, "GET", `/presence?userIds=${aId}`)).statusCode, 404, "no lookup by id");
  void xId;
});

test("deliveredSeq advances on ack, survives deletion, sync/wait wakes sender", async () => {
  const ids: string[] = [];
  // clientMsgId must be >= 8 chars
  for (const k of ["pmsg-00001", "pmsg-00002", "pmsg-00003"]) ids.push((await send(A, conv, k)).json().message.id);
  assert.equal((await member(A, conv, bId)).deliveredSeq, "0");
  const boot = await wait(A);
  // Ack out of order: m2 only => watermark stays at 0 (m1 still pending)
  const waiting = wait(A, `?since=${boot.cursor}&timeout=5`);
  await new Promise((r) => setTimeout(r, 300));
  await call(B, "POST", "/messages/ack", { messageIds: [ids[1]] });
  assert.equal((await member(A, conv, bId)).deliveredSeq, "0");
  await call(B, "POST", "/messages/ack", { messageIds: [ids[0]] });
  const w = await waiting;
  assert.equal(w.changed, true);
  assert.deepEqual(w.delivered, [conv]);
  assert.equal((await member(A, conv, bId)).deliveredSeq, "2");
  await call(B, "POST", "/messages/ack", { messageIds: [ids[2]] });
  const m = await member(A, conv, bId);
  assert.equal(m.deliveredSeq, "3"); assert.ok(m.deliveredAt);
  assert.equal((await pg.query(`SELECT 1 FROM messages WHERE conversation_id = $1`, [conv])).rows.length, 0, "ciphertext deleted");
  assert.equal((await member(B, conv, bId)).deliveredSeq, "3", "readable by any member, after deletion");
  // Next wait with the new cursor does not re-report the same delivery.
  const after = await wait(A, `?since=${w.cursor}&timeout=1`);
  assert.equal(after.changed, true); // m3 ack advanced again after w's cursor
  const quiet = await wait(A, `?since=${after.cursor}&timeout=1`);
  assert.equal(quiet.changed, false);
});

test("old v2 cursor returns immediately with v3", async () => {
  const r = await wait(A, "?since=v2.1.0.0.0.0.0.0&timeout=5");
  assert.match(r.cursor, /^v3\./);
});
