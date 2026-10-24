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
