// Auth length limits (shared constants) + signout invalidates the session server-side.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { USERNAME_MAX, PASSWORD_MAX, USERNAME_PATTERN } from "@e2ee/shared";
import { setTestDb, type Queryable } from "../src/database/db.js";
import { buildApp } from "../src/app.js";

const pg = new PGlite();
const wrap = (c: PGlite | Transaction): Queryable => ({
  async query(text: string, values?: unknown[]) {
    const r = await c.query(text, values as never[]);
    return { rows: r.rows as never[], rowCount: Math.max(r.affectedRows ?? 0, r.rows.length) };
  },
});
let app: FastifyInstance;
let n = 0;
before(async () => {
  const dir = join(import.meta.dirname, "../prisma/migrations");
  for (const m of readdirSync(dir).filter((d) => /^\d/.test(d)).sort()) await pg.exec(readFileSync(join(dir, m, "migration.sql"), "utf8"));
  setTestDb({ ...wrap(pg), tx: (fn) => pg.transaction((t) => fn(wrap(t))) });
  process.env.LOG_LEVEL = "silent";
  app = buildApp();
  await app.ready();
});
after(async () => { await app.close(); await pg.close(); });
// Fresh IP per call so the per-IP limiter never interferes.
const signup = (username: string, password = "correct-horse-battery") =>
  app.inject({ method: "POST", url: "/auth/signup", payload: { username, password }, headers: { "x-real-ip": `10.9.${n >> 8}.${n++ & 255}` } });

test("shared constants", () => {
  assert.equal(USERNAME_MAX, 64);
  assert.equal(PASSWORD_MAX, 1024);
  assert.ok(USERNAME_PATTERN.test("a".repeat(64)));
  assert.ok(!USERNAME_PATTERN.test("a".repeat(65)));
  assert.ok(!USERNAME_PATTERN.test("ab"));
});

test("username boundary 64 ok / 65 rejected", async () => {
  assert.equal((await signup("u".repeat(64))).statusCode, 201);
  assert.equal((await signup("v".repeat(65))).statusCode, 400);
  assert.equal((await signup("ab")).statusCode, 400);
  assert.equal((await signup("bad-char!")).statusCode, 400);
});

test("password boundary 1024 ok / 1025 rejected, min 10", async () => {
  assert.equal((await signup("pw1024", "p".repeat(1024))).statusCode, 201);
  assert.equal((await signup("pw1025", "p".repeat(1025))).statusCode, 400);
  assert.equal((await signup("pw9", "p".repeat(9))).statusCode, 400);
});

test("64-char username works for identity lookup and conversation start", async () => {
  const a = await signup("alice64");
  const cookie = String(a.headers["set-cookie"]).split(";")[0]!;
  const id = await app.inject({ method: "GET", url: `/keys/identity/${"u".repeat(64)}`, headers: { cookie } });
  assert.notEqual(id.statusCode, 400);
  const bad = await app.inject({ method: "GET", url: `/keys/identity/${"u".repeat(65)}`, headers: { cookie } });
  assert.equal(bad.statusCode, 400);
  const c = await app.inject({ method: "POST", url: "/conversations", payload: { username: "u".repeat(64) }, headers: { cookie } });
  assert.notEqual(c.statusCode, 400);
  const c2 = await app.inject({ method: "POST", url: "/conversations", payload: { username: "u".repeat(65) }, headers: { cookie } });
  assert.equal(c2.statusCode, 400);
});

test("signout deletes the session row and clears the cookie", async () => {
  const s = await signup("signouter");
  const cookie = String(s.headers["set-cookie"]).split(";")[0]!;
  const before = (await pg.query<{ c: number }>(`SELECT count(*)::int AS c FROM sessions`)).rows[0]!.c;
  const r = await app.inject({ method: "POST", url: "/auth/signout", headers: { cookie } });
  assert.equal(r.statusCode, 204);
  assert.match(String(r.headers["set-cookie"]), /Expires=Thu, 01 Jan 1970|Max-Age=0/i);
  const after = (await pg.query<{ c: number }>(`SELECT count(*)::int AS c FROM sessions`)).rows[0]!.c;
  assert.equal(after, before - 1);
  assert.equal((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).statusCode, 401);
});
