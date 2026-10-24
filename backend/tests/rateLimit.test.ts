// E2EE-75: shared (Postgres-backed) rate limiting. Real migrations on in-process PGlite.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { setTestDb, type Queryable } from "../src/database/db.js";
import { buildApp } from "../src/app.js";
import { PgRateLimiter, limiter, setRateLimiter, type RateLimiter } from "../src/utils/rateLimiter.js";

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

const creds = (username: string, password = "correct-horse-battery") => ({ username, password });
const post = (a: FastifyInstance, url: string, payload: object, ip: string) =>
  a.inject({ method: "POST", url, payload, headers: { "x-real-ip": ip } });

test("per-IP auth limit: 21st attempt is 429 with retry-after, counted in shared store", async () => {
  const codes: number[] = [];
  for (let i = 0; i < 21; i++) codes.push((await post(app, "/auth/signin", creds(`nobody${i}`, "wrong-password-x"), "10.0.0.1")).statusCode);
  assert.deepEqual(codes.slice(0, 20), Array(20).fill(401));
  const r = await post(app, "/auth/signin", creds("nobody", "wrong-password-x"), "10.0.0.1");
  assert.equal(r.statusCode, 429);
  // Body shape is unchanged from before E2EE-75 (the app error handler maps plugin 429s).
  assert.match(r.json().message, /Too many attempts/);
  assert.ok(Number(r.headers["retry-after"]) > 0 && Number(r.headers["retry-after"]) <= 900);
  const row = await pg.query<{ count: number }>(`SELECT count FROM rate_limits WHERE key = 'rl:auth:10.0.0.1'`);
  assert.ok(row.rows[0]!.count >= 21);
});

test("limits survive a cold start (fresh app instance shares the counters)", async () => {
  const cold = buildApp();
  await cold.ready();
  const r = await post(cold, "/auth/signup", creds("coldstart"), "10.0.0.1");
  assert.equal(r.statusCode, 429, "new instance still sees the IP as limited");
  await cold.close();
});

test("per-username lockout: identical 429 for existing and non-existent accounts", async () => {
  assert.equal((await post(app, "/auth/signup", creds("victim"), "10.0.1.1")).statusCode, 201);
  const bodies: Record<string, unknown> = {};
  for (const [u, ipBase] of [["victim", "10.0.2."], ["ghostuser", "10.0.3."]] as const) {
    // vary the IP so only the per-username limit can trigger
    for (let i = 0; i < 10; i++) assert.equal((await post(app, "/auth/signin", creds(u, "wrong-password-x"), `${ipBase}${i}`)).statusCode, 401);
    const r = await post(app, "/auth/signin", creds(u, u === "victim" ? "correct-horse-battery" : "x-wrong-pass"), `${ipBase}99`);
    assert.equal(r.statusCode, 429, `${u} locked even with the right password`);
    const ra = Number(r.headers["retry-after"]);
    assert.ok(ra > 0 && ra <= 300);
    bodies[u] = r.json();
  }
  assert.deepEqual(bodies.victim, bodies.ghostuser, "no enumeration signal");
});

test("successful signin clears the username failure history", async () => {
  assert.equal((await post(app, "/auth/signup", creds("carefuluser"), "10.0.4.1")).statusCode, 201);
  for (let i = 0; i < 9; i++) await post(app, "/auth/signin", creds("carefuluser", "wrong-password-x"), `10.0.5.${i}`);
  assert.equal((await post(app, "/auth/signin", creds("carefuluser"), "10.0.5.50")).statusCode, 200);
  for (let i = 0; i < 9; i++) assert.equal((await post(app, "/auth/signin", creds("carefuluser", "wrong-password-x"), `10.0.6.${i}`)).statusCode, 401);
});

test("limiter primitives: fixed window, sliding window, lock, cleanup", async () => {
  const l = new PgRateLimiter();
  assert.equal((await l.hit("t:fixed", 60_000)).count, 1);
  const h = await l.hit("t:fixed", 60_000);
  assert.equal(h.count, 2);
  assert.ok(h.resetMs > 0 && h.resetMs <= 60_000);
  await pg.query(`UPDATE rate_limits SET expires_at = now() - interval '1 second' WHERE key = 't:fixed'`);
  assert.equal((await l.hit("t:fixed", 60_000)).count, 1, "expired window restarts");
  assert.equal(await l.slidingHit("t:slide", 60_000), 1);
  assert.equal(await l.slidingHit("t:slide", 60_000), 2);
  await pg.query(`UPDATE rate_limits SET hits = ARRAY[now() - interval '2 minutes', now()] WHERE key = 't:slide'`);
  assert.equal(await l.slidingHit("t:slide", 60_000), 2, "old hits slide out");
  assert.equal(await l.lockedFor("t:lock"), 0);
  await l.lock("t:lock", 5000);
  assert.ok((await l.lockedFor("t:lock")) > 0);
  await pg.query(`UPDATE rate_limits SET expires_at = now() - interval '1 second' WHERE key IN ('t:lock','t:slide')`);
  await l.cleanup();
  const left = await pg.query<{ key: string }>(`SELECT key FROM rate_limits WHERE key LIKE 't:%'`);
  assert.deepEqual(left.rows.map((r) => r.key), ["t:fixed"]);
});

test("store outage: key routes fail OPEN, auth fails CLOSED", async () => {
  const sessionCookie = async (u: string) => {
    const r = await post(app, "/auth/signup", creds(u), `10.0.7.${u.length}`);
    return `e2ee_session=${r.cookies.find((c) => c.name === "e2ee_session")?.value}`;
  };
  const a = await sessionCookie("outagea");
  const b = await sessionCookie("outageb2");
  const k = (n: number) => Buffer.alloc(n, 7).toString("base64");
  const pub = await app.inject({ method: "POST", url: "/keys/publish", headers: { cookie: b }, payload: {
    identityKey: { publicKey: k(33), version: 1 }, signedPrekey: { keyId: 1, publicKey: k(33), signature: k(64), version: 1 },
    oneTimePrekeys: [{ keyId: 1, publicKey: k(33), version: 1 }] } });
  assert.equal(pub.statusCode, 200);
  const real = limiter();
  const boom = async () => { throw new Error("db down"); };
  const broken: RateLimiter = { hit: boom, slidingHit: boom, lockedFor: boom, lock: boom, reset: boom };
  setRateLimiter(broken);
  try {
    const bundle = await app.inject({ method: "GET", url: "/keys/bundle/outageb2", headers: { cookie: a } });
    assert.equal(bundle.statusCode, 200, "messaging keeps working when the limiter store is down");
    const signin = await post(app, "/auth/signin", creds("outagea"), "10.0.8.1");
    assert.equal(signin.statusCode, 500, "auth refuses rather than running unthrottled");
    assert.equal(signin.json().error, "internal_error");
  } finally {
    setRateLimiter(real);
  }
});
