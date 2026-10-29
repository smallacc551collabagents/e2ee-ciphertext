// Message retention, reference-aware attachment retention, and E2EE-72 account delete.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { setTestDb, type Queryable } from "../src/database/db.js";
import { buildApp } from "../src/app.js";
import { setObjectStore, type ObjectStore } from "../src/services/objectStore.js";
import { sweepMessages } from "../src/services/retention.js";
import { sweepAttachments } from "../src/routes/attachments.js";

const pg = new PGlite();
const wrap = (c: PGlite | Transaction): Queryable => ({
  async query(text: string, values?: unknown[]) {
    const r = await c.query(text, values as never[]);
    return { rows: r.rows as never[], rowCount: Math.max(r.affectedRows ?? 0, r.rows.length) };
  },
});

const objects = new Map<string, Buffer>();
const posts: { key: string; maxBytes: number; expiresSec: number }[] = [];
const fake: ObjectStore = {
  async presignPost(key, maxBytes, expiresSec) {
    posts.push({ key, maxBytes, expiresSec });
    return { url: "https://storage.test/e2ee-attachments", fields: { key, Policy: "p", "X-Amz-Signature": "s" } };
  },
  async presignGet(key, expiresSec) { return `https://storage.test/e2ee-attachments/${key}?X-Amz-Expires=${expiresSec}`; },
  async size(key) { return objects.get(key)?.length ?? null; },
  async sha256(key) { const b = objects.get(key); return b ? sha(b) : null; },
  async delete(key) { objects.delete(key); },
};
const sha = (b: Buffer) => createHash("sha256").update(b).digest("base64");

let app: FastifyInstance;
before(async () => {
  const dir = join(import.meta.dirname, "../prisma/migrations");
  for (const m of readdirSync(dir).filter((d) => /^\d/.test(d)).sort()) await pg.exec(readFileSync(join(dir, m, "migration.sql"), "utf8"));
  setTestDb({ ...wrap(pg), tx: (fn) => pg.transaction((t) => fn(wrap(t))) });
  setObjectStore(fake);
  process.env.LOG_LEVEL = "silent";
  app = buildApp();
  await app.ready();
});
after(async () => { await app.close(); await pg.close(); });

let n = 0;
async function signup(username: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/auth/signup", payload: { username, password: "correct-horse-battery" }, headers: { "x-real-ip": `10.8.0.${++n}` } });
  return `e2ee_session=${r.cookies.find((x) => x.name === "e2ee_session")?.value}`;
}
const call = (cookie: string | null, method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, ...(payload ? { payload } : {}), headers: cookie ? { cookie } : {} });

let alice = "", bob = "", eve = "", conv = "";
const blob = (len: number, fill = 3) => Buffer.alloc(len, fill);
const uploadUrl = (cookie: string, b: Buffer, size = b.length, conversationId = conv) =>
  call(cookie, "POST", "/attachments/upload-url", { conversationId, size, sha256: sha(b) });

const ct = Buffer.alloc(40, 7).toString("base64");
let cid = 0;
const send = (cookie: string, conversationId: string, extra: object = {}) =>
  call(cookie, "POST", `/conversations/${conversationId}/messages`, { clientMsgId: `cmsg-${++cid}-abcdef`, ciphertext: ct, version: 1, ...extra });
async function stored(cookie: string, conversationId = conv): Promise<string> {
  const b = blob(100, cid++ % 200);
  const ref = (await uploadUrl(cookie, b, b.length, conversationId)).json().ref;
  objects.set(`a/${ref}`, b);
  assert.equal((await call(cookie, "POST", `/attachments/${ref}/complete`)).statusCode, 200);
  return ref;
}
const exists = async (table: string, col: string, v: string) => (await pg.query(`SELECT 1 FROM ${table} WHERE ${col} = $1`, [v])).rows.length > 0;
const expire = (ref: string) => pg.query(`UPDATE attachments SET expires_at = now() - interval '1 second' WHERE ref = $1`, [ref]);

test("setup", async () => {
  alice = await signup("ralice"); bob = await signup("rbob"); eve = await signup("reve");
  conv = (await call(alice, "POST", "/conversations", { username: "rbob" })).json().conversation.id;
  assert.ok(conv);
});

test("acked messages are deleted immediately; unacked kept until 30 days", async () => {
  const m1 = (await send(alice, conv)).json().message.id;
  const m2 = (await send(alice, conv)).json().message.id;
  assert.equal((await call(bob, "POST", "/messages/ack", { messageIds: [m1] })).json().acked, 1);
  assert.ok(!(await exists("messages", "id", m1)), "acked => deleted");
  assert.ok(await exists("messages", "id", m2));
  await sweepMessages();
  assert.ok(await exists("messages", "id", m2), "unacked survives sweep");
  await pg.query(`UPDATE messages SET created_at = now() - interval '31 days' WHERE id = $1`, [m2]);
  await sweepMessages();
  assert.ok(!(await exists("messages", "id", m2)), "30-day undelivered dropped");
});

test("attachmentRefs: validated (own, stored, this conversation)", async () => {
  const ref = await stored(alice);
  assert.equal((await send(bob, conv, { attachmentRefs: [ref] })).statusCode, 400, "not the uploader");
  const other = (await call(alice, "POST", "/conversations", { username: "reve" })).json().conversation.id;
  assert.equal((await send(alice, other, { attachmentRefs: [ref] })).statusCode, 400, "other conversation");
  assert.equal((await send(alice, conv, { attachmentRefs: ["x"] })).statusCode, 400, "bad ref shape");
  assert.equal((await send(alice, conv, { attachmentRefs: [ref, ref] })).statusCode, 400, "dupes");
  const pend = (await uploadUrl(alice, blob(80))).json().ref;
  assert.equal((await send(alice, conv, { attachmentRefs: [pend] })).statusCode, 400, "pending (not completed)");
  assert.equal((await send(alice, conv, { attachmentRefs: Array.from({ length: 11 }, (_, i) => String.fromCharCode(65 + i).repeat(43)) })).statusCode, 400, "max 10");
  assert.equal((await send(alice, conv, { attachmentRefs: [ref] })).statusCode, 201);
  assert.equal((await send(alice, conv)).statusCode, 201, "attachmentRefs optional");
});

test("attachment kept while an undelivered message references it, even past expiry", async () => {
  const ref = await stored(alice);
  const m = (await send(alice, conv, { attachmentRefs: [ref] })).json().message.id;
  await expire(ref);
  await sweepAttachments(1000);
  assert.ok(await exists("attachments", "ref", ref), "referenced => kept");
  assert.equal((await call(bob, "GET", `/attachments/${ref}/download-url`)).statusCode, 200, "still downloadable");
  // download-url slid expiry to now+30d
  const e = (await pg.query<{ e: Date }>(`SELECT expires_at e FROM attachments WHERE ref = $1`, [ref])).rows[0]!.e;
  assert.ok(new Date(e).getTime() > Date.now() + 29 * 86400_000);
  await call(bob, "POST", "/messages/ack", { messageIds: [m] });
  await sweepAttachments(1000);
  assert.ok(await exists("attachments", "ref", ref), "sliding expiry still holds");
  await expire(ref);
  await sweepAttachments(1000);
  assert.ok(!(await exists("attachments", "ref", ref)), "neither holds => deleted");
  assert.ok(!objects.has(`a/${ref}`));
  assert.equal((await call(bob, "GET", `/attachments/${ref}/download-url`)).statusCode, 404);
});

test("unreferenced, expired attachment is not downloadable and is swept", async () => {
  const ref = await stored(alice);
  await expire(ref);
  assert.equal((await call(bob, "GET", `/attachments/${ref}/download-url`)).statusCode, 404);
  await sweepAttachments(1000);
  assert.ok(!objects.has(`a/${ref}`));
});

test("DELETE /auth/me: auth, password, strict body", async () => {
  assert.equal((await call(null, "DELETE", "/auth/me", { password: "x" })).statusCode, 401);
  assert.equal((await call(eve, "DELETE", "/auth/me", { password: "wrong-password!" })).statusCode, 401);
  assert.equal((await call(eve, "DELETE", "/auth/me", { password: "correct-horse-battery", extra: 1 })).statusCode, 400);
  assert.equal((await call(eve, "DELETE", "/auth/me", {})).statusCode, 400);
});

test("DELETE /auth/me removes everything the user owns; others keep their side", async () => {
  const dave = await signup("rdave");
  const c2 = (await call(dave, "POST", "/conversations", { username: "rbob" })).json().conversation.id;
  const ref = await stored(dave, c2);
  await send(dave, c2, { attachmentRefs: [ref] });
  const fromBob = (await send(bob, c2)).json().message.id;
  const uid = (await call(dave, "GET", "/auth/me")).json().user.id;
  // solo conversation (other member gone) should be removed entirely
  await pg.query(`INSERT INTO one_time_prekeys (id, user_id, key_id, public_key, version) VALUES (gen_random_uuid(), $1, 1, '\\x01', 1)`, [uid]);
  const r = await call(dave, "DELETE", "/auth/me", { password: "correct-horse-battery" });
  assert.equal(r.statusCode, 204);
  const ck = r.cookies.find((x) => x.name === "e2ee_session");
  assert.ok(ck && (ck.value === "" || (ck.expires && ck.expires.getTime() < Date.now())), "cookie cleared");
  for (const [t, col] of [["users", "id"], ["sessions", "user_id"], ["one_time_prekeys", "user_id"], ["identity_keys", "user_id"],
    ["conversation_members", "user_id"], ["messages", "sender_id"], ["message_deliveries", "recipient_id"], ["attachments", "owner_user_id"]] as const)
    assert.ok(!(await exists(t, col, uid)), `${t} cleared`);
  assert.ok(!objects.has(`a/${ref}`), "blob deleted");
  assert.ok(await exists("conversations", "id", c2), "bob still a member => conversation kept");
  assert.equal((await call(dave, "GET", "/auth/me")).statusCode, 401, "session gone");
  await sweepMessages();
  assert.ok(!(await exists("messages", "id", fromBob)), "message only the deleted user was owed is swept");
  // Bob deletes too => conversation now empty => removed.
  assert.equal((await call(bob, "DELETE", "/auth/me", { password: "correct-horse-battery" })).statusCode, 204);
  assert.ok(!(await exists("conversations", "id", c2)), "empty conversation removed");
  assert.ok(await exists("users", "username", "ralice"), "unrelated user untouched");
});
