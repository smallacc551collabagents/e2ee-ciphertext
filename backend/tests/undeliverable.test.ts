// Resend-on-new-identity ("incognito" scenario): real migrations on PGlite + real Fastify app.
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
const send = (cookie: string, conv: string, id: string, fill = 40) =>
  call(cookie, "POST", `/conversations/${conv}/messages`, { clientMsgId: id, ciphertext: b64(40, fill), version: 1 });
const msgs = async (c: string, conv: string) => (await call(c, "GET", `/conversations/${conv}/messages`)).json().messages as { id: string; seq: string; clientMsgId: string; ciphertext: string }[];
const undeliv = (c: string, conv: string) => call(c, "GET", `/conversations/${conv}/undeliverable`);

let a = "", b = "", e = "", conv = "", bId = "";
test("setup", async () => {
  a = await signup("ualice"); b = await signup("ubob"); e = await signup("ueve");
  for (const [c, f] of [[a, 1], [b, 2], [e, 3]] as const) assert.equal((await publish(c, f)).statusCode, 200);
  const r = await call(a, "POST", "/conversations", { username: "ubob" });
  conv = r.json().conversation.id;
  bId = r.json().conversation.members.find((m: { username: string }) => m.username === "ubob").id;
});

test("same-identity republish (OTK refill / identical identity) flags nothing", async () => {
  for (const id of ["m-same-01", "m-same-02"]) assert.equal((await send(a, conv, id)).statusCode, 201);
  assert.equal((await call(b, "POST", "/keys/publish", { oneTimePrekeys: [{ keyId: 9, publicKey: b64(33, 9), version: 1 }] })).statusCode, 200);
  assert.equal((await publish(b, 2, 10)).statusCode, 200);
  const bm = await msgs(b, conv);
  assert.equal(bm.length, 2);
  assert.deepEqual((await undeliv(a, conv)).json(), { undeliverable: [] });
  assert.equal((await call(b, "POST", "/messages/ack", { messageIds: bm.map((m) => m.id) })).json().acked, 2);
});

test("incognito scenario: A sends 3, B new identity, B sees none, A lists 3, A resends, B gets 3 same seqs", async () => {
  const ids = ["m-off-0001", "m-off-0002", "m-off-0003"];
  const sent = [];
  for (const id of ids) { const r = await send(a, conv, id); assert.equal(r.statusCode, 201); sent.push(r.json().message); }
  assert.equal((await publish(b, 42, 20)).statusCode, 200); // B: "Use this browser"
  assert.deepEqual(await msgs(b, conv), []);
  // B acking hidden ids is a no-op.
  assert.equal((await call(b, "POST", "/messages/ack", { messageIds: sent.map((m) => m.id) })).json().acked, 0);
  const u = (await undeliv(a, conv)).json().undeliverable;
  assert.deepEqual(u, sent.map((m) => ({ messageId: m.id, clientMsgId: m.clientMsgId, seq: m.seq, recipientId: bId, reason: "undeliverable_device_changed" })));
  // B (recipient, not sender) sees nothing; non-member gets 404.
  assert.deepEqual((await undeliv(b, conv)).json(), { undeliverable: [] });
  assert.equal((await undeliv(e, conv)).statusCode, 404);
  // Resend with the same clientMsgIds + new ciphertext: replaced in place.
  for (const [i, id] of ids.entries()) {
    const r = await send(a, conv, id, 99);
    assert.equal(r.statusCode, 200); assert.equal(r.json().duplicate, false);
    assert.equal(r.json().message.id, sent[i].id); assert.equal(r.json().message.seq, sent[i].seq);
  }
  // A second identical resend is now an ordinary duplicate.
  assert.equal((await send(a, conv, ids[0]!, 99)).json().duplicate, true);
  const bm = await msgs(b, conv);
  assert.deepEqual(bm.map((m) => m.seq), sent.map((m) => m.seq));
  assert.ok(bm.every((m) => m.ciphertext === b64(40, 99)));
  assert.deepEqual((await undeliv(a, conv)).json(), { undeliverable: [] });
  assert.equal((await call(b, "POST", "/messages/ack", { messageIds: bm.map((m) => m.id) })).json().acked, 3);
});

test("flagged messages still expire at 30 days; account delete removes them", async () => {
  assert.equal((await send(a, conv, "m-exp-0001")).statusCode, 201);
  assert.equal((await publish(b, 77, 30)).statusCode, 200);
  assert.equal((await undeliv(a, conv)).json().undeliverable.length, 1);
  await pg.query(`UPDATE messages SET created_at = now() - interval '31 days'`);
  await sweepMessages();
  assert.equal((await undeliv(a, conv)).json().undeliverable.length, 0);
  assert.equal((await send(a, conv, "m-del-0001")).statusCode, 201);
  assert.equal((await publish(b, 78, 31)).statusCode, 200);
  const d = await call(b, "DELETE", "/auth/me", { password: "correct-horse-battery" });
  assert.ok(d.statusCode < 300, String(d.statusCode));
  assert.equal((await pg.query(`SELECT 1 FROM message_deliveries WHERE undeliverable_reason IS NOT NULL`)).rows.length, 0);
});
