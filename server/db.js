// SMA V08 - Postgres (Supabase) database connection.
//
// This file owns the connection pool and the transaction helper; schema
// creation/migrations/seed live in schema.js, table config + generic CRUD in
// queries.js, and password/PIN hashing in authUtils.js — all re-exported here
// so existing `from './db.js'` imports across the server don't need to change.
import 'dotenv/config';
import { Pool, types } from 'pg';

// DATE columns default to parsing into a JS Date object, which then
// JSON-serializes as a full "YYYY-MM-DDT00:00:00.000Z" timestamp — every
// day-string comparison in the client (today(), CSV export, exact-match
// filters) expects a bare "YYYY-MM-DD". Keep DATE as the raw wire string
// (already "YYYY-MM-DD") instead. TIMESTAMPTZ is left as a Date object: it
// JSON-serializes to the same ISO format the client already wrote via
// `new Date().toISOString()`, so no callers need to change.
types.setTypeParser(1082, (v) => v);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase requires SSL; PGSSLMODE=disable lets a local dev Postgres work.
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  // Without a cap, a bad DATABASE_URL (wrong host/port, blocked egress) hangs
  // forever with no error — the host just looks like it never started.
  connectionTimeoutMillis: 10000
});

// Runs fn(client) inside BEGIN/COMMIT, rolling back on error.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export * from './authUtils.js';
export * from './queries.js';
export * from './schema.js';
