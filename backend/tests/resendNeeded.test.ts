// Resend-on-new-identity: real migrations on PGlite + real Fastify app.
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
const send = (cookie: string, conv: string, id: string) =>
  call(cookie, "POST", `/conversations/${conv}/messages`, { clientMsgId: id, ciphertext: b64(40), version: 1 });

let a = "", b = "", e = "", conv = "", bId = "", eConv = "";
test("setup", async () => {
  a = await signup("ralice"); b = await signup("rbob"); e = await signup("reve");
  for (const [c, f] of [[a, 1], [b, 2], [e, 3]] as const) assert.equal((await publish(c, f)).statusCode, 200);
  const r = await call(a, "POST", "/conversations", { username: "rbob" });
  conv = r.json().conversation.id;
  bId = r.json().conversation.members.find((m: { username: string }) => m.username === "rbob").id;
  eConv = (await call(e, "POST", "/conversations", { username: "rbob" })).json().conversation.id;
});

test("same-identity republish (OTK refill / SPK rotate) triggers nothing", async () => {
  for (const id of ["m-same-01", "m-same-02"]) assert.equal((await send(a, conv, id)).statusCode, 201);
  assert.equal((await call(b, "POST", "/keys/publish", { oneTimePrekeys: [{ keyId: 9, publicKey: b64(33, 9), version: 1 }] })).statusCode, 200);
  assert.equal((await publish(b, 2, 10)).statusCode, 200); // identical identity key re-sent
  const bp = (await call(b, "GET", `/conversations/${conv}/messages`)).json();
  assert.equal(bp.messages.length, 2);
  assert.equal((await call(a, "GET", `/conversations/${conv}/messages`)).json().resendNeeded, undefined);
  const ack = await call(b, "POST", "/messages/ack", { messageIds: bp.messages.map((m: { id: string }) => m.id) });
  assert.equal(ack.json().acked, 2);
});

test("new identity: B's 3 queued msgs leave B's queue and come back to A", async () => {
  const ids = ["m-stale-01", "m-stale-02", "m-stale-03"];
  for (const id of ids) assert.equal((await send(a, conv, id)).statusCode, 201);
  assert.equal((await send(e, eConv, "m-eve-0001")).statusCode, 201); // Eve's message to B
  assert.equal((await publish(b, 42, 20)).statusCode, 200); // B: new device
  const bp = (await call(b, "GET", `/conversations/${conv}/messages`)).json();
  assert.deepEqual(bp.messages, []);
  assert.equal(bp.resendNeeded, undefined);
  const ap = (await call(a, "GET", `/conversations/${conv}/messages`)).json();
  assert.deepEqual(ap.resendNeeded.map((x: { clientMsgId: string }) => x.clientMsgId).sort(), ids);
  for (const x of ap.resendNeeded) {
    assert.equal(x.conversationId, conv); assert.equal(x.reason, "identity_changed");
    assert.deepEqual(x.recipient, { id: bId, username: "rbob" });
  }
  // Non-members / other senders can't see A's entries.
  assert.equal((await call(e, "GET", `/conversations/${conv}/messages`)).statusCode, 404);
  const ep = (await call(e, "GET", `/conversations/${eConv}/messages`)).json();
  assert.deepEqual(ep.resendNeeded.map((x: { clientMsgId: string }) => x.clientMsgId), ["m-eve-0001"]);
  // Eve can't clear A's entries.
  const bad = await call(e, "POST", "/messages/ack", { resendAcks: [{ conversationId: conv, clientMsgId: ids[0], recipientId: bId }] });
  assert.equal(bad.json().resendAcked, 0);

  // Resend with the SAME clientMsgId is accepted (not deduped), auto-clears the entry, and B sees it.
  const rs = await send(a, conv, ids[0]!);
  assert.equal(rs.statusCode, 201); assert.equal(rs.json().duplicate, false);
  assert.equal((await call(b, "GET", `/conversations/${conv}/messages`)).json().messages.length, 1);
  // Explicit clear for the rest.
  const ok = await call(a, "POST", "/messages/ack", { resendAcks: ids.slice(1).map((m) => ({ conversationId: conv, clientMsgId: m, recipientId: bId })) });
  assert.equal(ok.json().resendAcked, 2);
  assert.equal((await call(a, "GET", `/conversations/${conv}/messages`)).json().resendNeeded, undefined);
  // Ack validation: empty body rejected, old shape still fine.
  assert.equal((await call(a, "POST", "/messages/ack", {})).statusCode, 400);
});

test("stale entries expire after 30 days; account delete removes them", async () => {
  await pg.query(`UPDATE resend_needed SET created_at = now() - interval '31 days'`);
  await sweepMessages();
  assert.equal((await pg.query(`SELECT 1 FROM resend_needed`)).rows.length, 0);
  assert.equal((await send(a, conv, "m-del-0001")).statusCode, 201);
  assert.equal((await publish(b, 77, 30)).statusCode, 200);
  assert.equal((await pg.query(`SELECT 1 FROM resend_needed`)).rows.length, 2); // + unacked resend of m-stale-01
  const d = await call(b, "DELETE", "/auth/me", { password: "correct-horse-battery" });
  assert.ok(d.statusCode < 300, String(d.statusCode));
  assert.equal((await pg.query(`SELECT 1 FROM resend_needed`)).rows.length, 0);
});
