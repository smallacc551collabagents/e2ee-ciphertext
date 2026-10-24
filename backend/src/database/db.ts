import pg from "pg";

// Single small pool per (serverless) instance. Neon pooled endpoint handles fan-out.
let pool: pg.Pool | undefined;
export const db = (): pg.Pool =>
  (pool ??= new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10_000,
  }));

/** Minimal surface the routes rely on; lets tests inject an in-process Postgres (PGlite). */
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<R extends pg.QueryResultRow = any>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}
let override: (Queryable & { tx<T>(fn: (c: Queryable) => Promise<T>): Promise<T> }) | undefined;
export function setTestDb(d: typeof override): void { override = d; }

export const q = (): Queryable => override ?? db();

/** Run fn inside a single-connection transaction (BEGIN/COMMIT, ROLLBACK on throw). */
export async function tx<T>(fn: (c: Queryable) => Promise<T>): Promise<T> {
  if (override) return override.tx(fn);
  const c = await db().connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
