// GET /sync/wait long-poll doorbell: real migrations on PGlite + real Fastify app.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { setTestDb, type Queryable } from "../src/database/db.js";
import { buildApp } from "../src/app.js";
import { SYNC } from "../src/routes/sync.js";
import { syncWaitResponseSchema } from "@e2ee/shared";

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
const call = (cookie: string, method: "GET" | "POST", url: string, payload?: object) =>
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

let A = "", B = "", C = "", conv = "", cursorB = "";
test("setup", async () => {
  A = await signup("syncalice"); B = await signup("syncbob"); C = await signup("synccarol");
  for (const [i, c] of [A, B, C].entries()) assert.equal((await publish(c, i + 1)).statusCode, 200);
});

test("auth required", async () => {
  const r = await app.inject({ method: "GET", url: "/sync/wait?timeout=1" });
  assert.equal(r.statusCode, 401);
});

test("validation: bad cursor/timeout rejected", async () => {
  assert.equal((await call(B, "GET", "/sync/wait?since=junk")).statusCode, 400);
  assert.equal((await call(B, "GET", "/sync/wait?timeout=-1")).statusCode, 400);
  assert.equal((await call(B, "GET", "/sync/wait?extra=1")).statusCode, 400);
});

test("no since = immediate bootstrap cursor", async () => {
  const r = await wait(B);
  assert.equal(r.changed, false);
  assert.deepEqual(r.conversations, []);
  cursorB = r.cursor;
});

test("timeout returns changed:false", async () => {
  const t0 = Date.now();
  const r = await wait(B, `?since=${cursorB}&timeout=1`);
  assert.equal(r.changed, false);
  assert.equal(r.cursor, cursorB);
  assert.ok(Date.now() - t0 >= 900, "held until timeout");
});

test("new 1:1 conversation wakes the peer mid-wait", async () => {
  const p = wait(B, `?since=${cursorB}&timeout=5`);
  await new Promise((r) => setTimeout(r, 400));
  const t0 = Date.now();
  const cr = await call(A, "POST", "/conversations", { username: "syncbob" });
  conv = cr.json().conversation.id;
  const r = await p;
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(r.changed, true);
  assert.deepEqual(r.conversations, [conv]);
  assert.notEqual(r.cursor, cursorB);
  cursorB = r.cursor;
});

test("message arriving mid-wait wakes B; wait does not consume", async () => {
  const p = wait(B, `?since=${cursorB}&timeout=5`);
  await new Promise((r) => setTimeout(r, 400));
  const t0 = Date.now();
  assert.equal((await send(A, conv, "msg-00001")).statusCode, 201);
  const r = await p;
  assert.ok(Date.now() - t0 < 1500);
  assert.deepEqual(r, { changed: true, cursor: cursorB, conversations: [conv], toDevice: false });
  // Not acked: message still fetchable, and the next wait returns immediately.
  const m = (await call(B, "GET", `/conversations/${conv}/messages`)).json().messages;
  assert.equal(m.length, 1);
  const t1 = Date.now();
  assert.equal((await wait(B, `?since=${cursorB}&timeout=5`)).changed, true);
  assert.ok(Date.now() - t1 < 500, "immediate when pending");
  // After ack: quiet again.
  assert.equal((await call(B, "POST", "/messages/ack", { messageIds: [m[0].id] })).statusCode, 200);
  assert.equal((await wait(B, `?since=${cursorB}&timeout=1`)).changed, false);
});

test("sender is not woken by own message; other users never see it", async () => {
  const a0 = await wait(A);
  const c0 = await wait(C);
  assert.equal((await send(A, conv, "msg-00002")).statusCode, 201);
  const a = await wait(A, `?since=${a0.cursor}&timeout=1`);
  assert.equal(a.changed, false);
  const c = await wait(C, `?since=${c0.cursor}&timeout=1`);
  assert.deepEqual(c, { changed: false, cursor: c0.cursor, conversations: [], toDevice: false });
  assert.deepEqual((await wait(B, `?since=${cursorB}&timeout=1`)).conversations, [conv]);
});

test("pending to-device sets toDevice", async () => {
  assert.ok((await call(A, "POST", "/conversations", { username: "synccarol" })).statusCode < 300);
  const c0 = await wait(C);
  const r = await call(A, "POST", "/to-device", { messages: [{ recipient: "synccarol", ciphertext: b64(40), type: 1, version: 1 }] });
  assert.ok(r.statusCode < 300, r.body);
  const c = await wait(C, `?since=${c0.cursor}&timeout=2`);
  assert.equal(c.changed, true);
  assert.equal(c.toDevice, true);
  assert.deepEqual(c.conversations, []);
  assert.equal((await wait(B, `?since=${cursorB}&timeout=1`)).toDevice, false);
});
