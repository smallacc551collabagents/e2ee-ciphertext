// Integration tests: real Postgres semantics via in-process PGlite, real migrations, real Fastify app.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { setTestDb, type Queryable } from "../src/database/db.js";
import { buildApp } from "../src/app.js";

const pg = new PGlite();
// Race simulation: when set, the next idempotency pre-check "misses" (as if a concurrent
// request inserted the same clientMsgId between our SELECT and INSERT).
let hideNextDupCheck = false;
const wrap = (c: PGlite | Transaction): Queryable => ({
  async query(text: string, values?: unknown[]) {
    if (hideNextDupCheck && text.startsWith("SELECT * FROM messages WHERE conversation_id = $1 AND sender_id")) {
      hideNextDupCheck = false;
      return { rows: [], rowCount: 0 };
    }
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
  const c = r.cookies.find((x) => x.name === "e2ee_session");
  return `e2ee_session=${c?.value}`;
}
const call = (cookie: string | null, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, ...(payload ? { payload } : {}), headers: cookie ? { cookie } : {} });
const publish = (cookie: string, ids: number[]) => call(cookie, "POST", "/keys/publish", {
  identityKey: { publicKey: b64(33), version: 1 },
  signedPrekey: { keyId: 1, publicKey: b64(33), signature: b64(64), version: 1 },
  oneTimePrekeys: ids.map((keyId) => ({ keyId, publicKey: b64(33, keyId), version: 1 })),
});

let alice = "", bob = "", eve = "";
test("setup users", async () => { alice = await signup("alice"); bob = await signup("bob"); eve = await signup("eve"); });

test("all transport routes require auth", async () => {
  for (const [m, u] of [["GET", "/keys/count"], ["GET", "/conversations"], ["GET", "/keys/bundle/alice"], ["POST", "/messages/ack"]] as const) {
    const r = await call(null, m, u, m === "POST" ? { messageIds: [] } : undefined);
    assert.equal(r.statusCode, 401, u);
  }
});

test("keys: publish, count, bundle consumes one-time prekeys atomically", async () => {
  assert.equal((await call(bob, "POST", "/keys/publish", { oneTimePrekeys: [{ keyId: 1, publicKey: b64(33), version: 1 }] })).statusCode, 400, "first publish needs identity");
  const p = await publish(bob, [10, 11]);
  assert.equal(p.statusCode, 200);
  assert.equal(p.json().oneTimePrekeyCount, 2);
  assert.equal((await call(bob, "POST", "/keys/publish", { oneTimePrekeys: [{ keyId: 10, publicKey: b64(33), version: 1 }] })).statusCode, 409, "keyId reuse rejected");
  const b1 = (await call(alice, "GET", "/keys/bundle/BOB")).json();
  const b2 = (await call(alice, "GET", "/keys/bundle/bob")).json();
  const b3 = (await call(alice, "GET", "/keys/bundle/bob")).json();
  assert.equal(b1.identityKey.publicKey, b64(33));
  assert.equal(b1.signedPrekey.signature, b64(64));
  assert.notEqual(b1.oneTimePrekey.keyId, b2.oneTimePrekey.keyId);
  assert.equal(b3.oneTimePrekey, null, "pool exhausted => null, never reused");
  assert.equal((await call(bob, "GET", "/keys/count")).json().oneTimePrekeyCount, 0);
  assert.equal((await call(alice, "GET", "/keys/bundle/eve")).statusCode, 404);
  assert.equal((await call(alice, "GET", "/keys/bundle/nobody")).statusCode, 404);
});

test("keys: validation caps", async () => {
  const big = await call(alice, "POST", "/keys/publish", { identityKey: { publicKey: b64(2000), version: 1 }, signedPrekey: { keyId: 1, publicKey: b64(33), signature: b64(64), version: 1 } });
  assert.equal(big.statusCode, 400);
  const many = await publish(alice, Array.from({ length: 101 }, (_, i) => i));
  assert.equal(many.statusCode, 400);
  const extra = await call(alice, "POST", "/keys/publish", { privateKey: b64(32) });
  assert.equal(extra.statusCode, 400, "unknown fields rejected");
});

let convId = "";
test("conversations: idempotent 1:1 create + list", async () => {
  const a = await call(alice, "POST", "/conversations", { username: "bob" });
  assert.equal(a.statusCode, 201);
  convId = a.json().conversation.id;
  const b = await call(bob, "POST", "/conversations", { username: "alice" });
  assert.equal(b.statusCode, 200);
  assert.equal(b.json().conversation.id, convId);
  assert.equal((await call(alice, "POST", "/conversations", { username: "alice" })).statusCode, 400);
  assert.equal((await call(alice, "POST", "/conversations", { username: "ghost" })).statusCode, 404);
  const l = (await call(alice, "GET", "/conversations")).json().conversations;
  assert.equal(l.length, 1);
  assert.deepEqual(l[0].members.map((m: { username: string }) => m.username), ["alice", "bob"]);
  assert.equal((await call(eve, "GET", "/conversations")).json().conversations.length, 0);
});

test("messages: append, idempotency, seq, cursor, authz, ack", async () => {
  const send = (cookie: string, clientMsgId: string, ct = b64(100)) =>
    call(cookie, "POST", `/conversations/${convId}/messages`, { clientMsgId, ciphertext: ct, version: 1 });
  const m1 = await send(alice, "client-msg-0001");
  assert.equal(m1.statusCode, 201);
  const again = await send(alice, "client-msg-0001");
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().duplicate, true);
  assert.equal(again.json().message.id, m1.json().message.id);
  const m2 = await send(bob, "client-msg-0001"); // same client id, different sender => distinct
  assert.equal(m2.statusCode, 201);
  assert.equal(m2.json().message.seq, "2");

  assert.equal((await send(eve, "client-msg-0002")).statusCode, 404, "non-member cannot post");
  assert.equal((await call(eve, "GET", `/conversations/${convId}/messages`)).statusCode, 404, "non-member cannot read");
  assert.equal((await send(alice, "client-msg-0003", b64(40 * 1024))).statusCode, 400, "ciphertext cap");
  assert.equal((await send(alice, "client-msg-0004", "not base64!")).statusCode, 400);

  const all = (await call(bob, "GET", `/conversations/${convId}/messages`)).json();
  assert.deepEqual(all.messages.map((m: { seq: string }) => m.seq), ["1", "2"]);
  assert.equal(all.messages[0].ciphertext, b64(100));
  const after1 = (await call(bob, "GET", `/conversations/${convId}/messages?after=1`)).json();
  assert.deepEqual(after1.messages.map((m: { seq: string }) => m.seq), ["2"]);

  const id1 = m1.json().message.id;
  assert.equal((await call(eve, "POST", "/messages/ack", { messageIds: [id1] })).json().acked, 0, "cannot ack others' deliveries");
  assert.equal((await call(alice, "POST", "/messages/ack", { messageIds: [id1] })).json().acked, 0, "sender has no delivery row");
  assert.equal((await call(bob, "POST", "/messages/ack", { messageIds: [id1] })).json().acked, 1);
  assert.equal((await call(bob, "POST", "/messages/ack", { messageIds: [id1] })).json().acked, 0, "ack idempotent");
});

test("keys: failed publish rolls back fully (no partial identity replacement)", async () => {
  const carol = await signup("carol");
  assert.equal((await publish(carol, [1, 2, 3])).statusCode, 200);
  const before = (await call(alice, "GET", "/keys/bundle/carol")).json(); // consumes keyId 1
  assert.equal(before.oneTimePrekey.keyId, 1);
  // New identity + reuse of consumed keyId 1 => 409 AFTER the upsert + prekey delete ran in the tx.
  const bad = await call(carol, "POST", "/keys/publish", {
    identityKey: { publicKey: b64(33, 9), version: 2 },
    signedPrekey: { keyId: 2, publicKey: b64(33, 9), signature: b64(64, 9), version: 2 },
    oneTimePrekeys: [{ keyId: 1, publicKey: b64(33, 9), version: 2 }],
  });
  assert.equal(bad.statusCode, 409);
  assert.equal(bad.json().error, "prekey_id_conflict");
  assert.equal((await call(carol, "GET", "/keys/count")).json().oneTimePrekeyCount, 2, "existing one-time prekeys intact");
  const after = (await call(alice, "GET", "/keys/bundle/carol")).json();
  assert.equal(after.identityKey.publicKey, b64(33), "prior identity key intact");
  assert.equal(after.identityKey.version, 1);
  assert.equal(after.signedPrekey.keyId, 1);
});

test("messages: concurrent duplicate clientMsgId returns duplicate, not 500", async () => {
  const send = () => call(alice, "POST", `/conversations/${convId}/messages`, { clientMsgId: "race-msg-0001", ciphertext: b64(50), version: 1 });
  const first = await send();
  assert.equal(first.statusCode, 201);
  hideNextDupCheck = true; // second request "doesn't see" the first => hits the unique constraint
  const second = await send();
  assert.equal(hideNextDupCheck, false, "race path exercised");
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().duplicate, true);
  assert.equal(second.json().message.id, first.json().message.id);
  const msgs = (await call(bob, "GET", `/conversations/${convId}/messages?after=${first.json().message.seq}`)).json().messages;
  assert.equal(msgs.length, 0, "no extra row and the seq bump was rolled back");
  const next = await call(alice, "POST", `/conversations/${convId}/messages`, { clientMsgId: "race-msg-0002", ciphertext: b64(50), version: 1 });
  assert.equal(next.json().message.seq, String(Number(first.json().message.seq) + 1), "seq stays gap-free");
});

test("keys: per-target bundle limit applies across callers", async () => {
  const dave = await signup("dave");
  const frank = await signup("frank");
  assert.equal((await publish(dave, [1])).statusCode, 200);
  const codes: number[] = [];
  for (let i = 0; i < 31; i++) codes.push((await call(i % 2 ? alice : frank, "GET", "/keys/bundle/dave")).statusCode);
  assert.equal(codes.filter((c) => c === 200).length, 30);
  assert.equal(codes[30], 429, "31st request for the same target is limited regardless of caller");
  assert.equal((await call(frank, "GET", "/keys/bundle/carol")).statusCode, 200, "other targets unaffected");
});
