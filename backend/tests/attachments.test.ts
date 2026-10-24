// E2EE-47: attachment blob endpoints. PGlite + real migrations; object store is an in-memory fake.
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
import { ATTACHMENT_MAX_CIPHERTEXT_BYTES, sweepAttachments } from "../src/routes/attachments.js";

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
  const r = await app.inject({ method: "POST", url: "/auth/signup", payload: { username, password: "correct-horse-battery" }, headers: { "x-real-ip": `10.9.0.${++n}` } });
  return `e2ee_session=${r.cookies.find((x) => x.name === "e2ee_session")?.value}`;
}
const call = (cookie: string | null, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, ...(payload ? { payload } : {}), headers: cookie ? { cookie } : {} });

let alice = "", bob = "", eve = "", conv = "";
const blob = (len: number, fill = 3) => Buffer.alloc(len, fill);
const uploadUrl = (cookie: string, b: Buffer, size = b.length, conversationId = conv) =>
  call(cookie, "POST", "/attachments/upload-url", { conversationId, size, sha256: sha(b) });

test("setup", async () => {
  alice = await signup("alice"); bob = await signup("bob"); eve = await signup("eve");
  conv = (await call(alice, "POST", "/conversations", { username: "bob" })).json().conversation.id;
  assert.ok(conv);
});

test("cap equals crypto format v1 max ciphertext", () => {
  assert.equal(ATTACHMENT_MAX_CIPHERTEXT_BYTES, 25 * 1024 * 1024 + 24 + Math.ceil((25 * 1024 * 1024) / 65536) * 16);
  assert.equal(ATTACHMENT_MAX_CIPHERTEXT_BYTES, 26_220_824);
});

test("all attachment routes require auth (401 without cookie)", async () => {
  const ref = "A".repeat(43);
  assert.equal((await call(null, "POST", "/attachments/upload-url", { conversationId: conv, size: 100, sha256: sha(blob(100)) })).statusCode, 401);
  assert.equal((await call(null, "POST", `/attachments/${ref}/complete`)).statusCode, 401);
  assert.equal((await call(null, "GET", `/attachments/${ref}/download-url`)).statusCode, 401);
});

test("size cap: exactly the cap is accepted, one byte over is rejected; cap signed into the POST policy", async () => {
  const fakeSha = sha(blob(1));
  const ok = await call(alice, "POST", "/attachments/upload-url", { conversationId: conv, size: ATTACHMENT_MAX_CIPHERTEXT_BYTES, sha256: fakeSha });
  assert.equal(ok.statusCode, 201);
  const over = await call(alice, "POST", "/attachments/upload-url", { conversationId: conv, size: ATTACHMENT_MAX_CIPHERTEXT_BYTES + 1, sha256: fakeSha });
  assert.equal(over.statusCode, 400);
  assert.equal((await call(alice, "POST", "/attachments/upload-url", { conversationId: conv, size: 39, sha256: fakeSha })).statusCode, 400, "below min blob");
  const p = posts.at(-1)!;
  assert.equal(p.maxBytes, ATTACHMENT_MAX_CIPHERTEXT_BYTES);
  assert.ok(p.expiresSec <= 600);
  assert.equal(p.key, `a/${ok.json().ref}`, "policy pinned to the exact object key");
});

test("upload-url rejects non-members and unknown fields (no names/MIME accepted)", async () => {
  assert.equal((await uploadUrl(eve, blob(100))).statusCode, 404);
  const extra = await call(alice, "POST", "/attachments/upload-url", { conversationId: conv, size: 100, sha256: sha(blob(100)), name: "x.png" });
  assert.equal(extra.statusCode, 400);
});

test("ref lifecycle: pending -> stored, download for members only", async () => {
  const b = blob(1000);
  const r = await uploadUrl(alice, b);
  assert.equal(r.statusCode, 201);
  const { ref, upload, expiresAt, maxBytes } = r.json();
  assert.match(ref, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(typeof upload.url, "string"); assert.equal(typeof upload.fields, "object");
  assert.equal(maxBytes, ATTACHMENT_MAX_CIPHERTEXT_BYTES);
  assert.ok(Date.parse(expiresAt) - Date.now() <= 5 * 60_000 + 1000);
  const row = await pg.query<{ status: string; conversation_id: string }>(`SELECT status, conversation_id FROM attachments WHERE ref = $1`, [ref]);
  assert.equal(row.rows[0]!.status, "pending");
  assert.equal(row.rows[0]!.conversation_id, conv);

  assert.equal((await call(bob, "GET", `/attachments/${ref}/download-url`)).statusCode, 404, "pending not downloadable");
  assert.equal((await call(alice, "POST", `/attachments/${ref}/complete`)).statusCode, 409, "not uploaded yet");
  assert.equal((await call(bob, "POST", `/attachments/${ref}/complete`)).statusCode, 404, "only owner completes");

  objects.set(`a/${ref}`, b); // simulate the browser's presigned POST
  const c = await call(alice, "POST", `/attachments/${ref}/complete`);
  assert.equal(c.statusCode, 200); assert.equal(c.json().status, "stored");
  assert.equal((await call(alice, "POST", `/attachments/${ref}/complete`)).statusCode, 200, "idempotent");

  const d = await call(bob, "GET", `/attachments/${ref}/download-url`);
  assert.equal(d.statusCode, 200);
  assert.match(d.json().downloadUrl, new RegExp(`a/${ref}`));
  assert.equal((await call(eve, "GET", `/attachments/${ref}/download-url`)).statusCode, 404, "non-member denied");
  assert.equal((await call(bob, "GET", `/attachments/${"B".repeat(43)}/download-url`)).statusCode, 404);
  assert.equal((await call(bob, "GET", `/attachments/short/download-url`)).statusCode, 400);
});

test("size mismatch and sha256 mismatch are rejected and the object is deleted", async () => {
  const b = blob(500);
  const r1 = (await uploadUrl(alice, b)).json().ref;
  objects.set(`a/${r1}`, blob(501));
  assert.equal((await call(alice, "POST", `/attachments/${r1}/complete`)).statusCode, 422);
  assert.ok(!objects.has(`a/${r1}`));
  assert.equal((await pg.query(`SELECT 1 FROM attachments WHERE ref = $1`, [r1])).rows.length, 0);

  const r2 = (await uploadUrl(alice, b)).json().ref;
  objects.set(`a/${r2}`, blob(500, 9)); // same size, different bytes
  assert.equal((await call(alice, "POST", `/attachments/${r2}/complete`)).statusCode, 422);
  assert.ok(!objects.has(`a/${r2}`));
});

test("orphan GC: expired pending uploads and lapsed stored blobs are reaped", async () => {
  const pend = (await uploadUrl(alice, blob(64))).json().ref;
  objects.set(`a/${pend}`, blob(64));
  await pg.query(`UPDATE attachments SET expires_at = now() - interval '1 second' WHERE ref = $1`, [pend]);
  assert.equal((await call(alice, "POST", `/attachments/${pend}/complete`)).statusCode, 410);
  await pg.query(`UPDATE attachments SET expires_at = now() - interval '1 second', status = 'stored' WHERE ref <> $1`, [pend]);
  assert.ok((await sweepAttachments(1000)) >= 1);
  assert.equal((await pg.query(`SELECT 1 FROM attachments WHERE expires_at < now()`)).rows.length, 0);
  assert.ok(!objects.has(`a/${pend}`));
});

test("per-user rate limit on upload-url (30/min) in the shared store", async () => {
  const codes: number[] = [];
  for (let i = 0; i < 31; i++) codes.push((await uploadUrl(bob, blob(64))).statusCode);
  assert.deepEqual(codes.slice(0, 30), Array(30).fill(201));
  assert.equal(codes[30], 429);
  const row = await pg.query<{ key: string }>(`SELECT key FROM rate_limits WHERE key LIKE 'rl:att-up:%'`);
  assert.ok(row.rows.length >= 1);
});
