import pg from 'pg';
import { env, loadEnv } from './env.js';

loadEnv();

// timestamptz columns come back as JS Dates by default — keep that, but parse
// bigint counts (used by aggregate queries) as numbers instead of strings.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export type Db = pg.Pool | pg.PoolClient | pg.Client;

/**
 * Managed Postgres providers (Render, RDS, Supabase, etc.) require SSL on
 * every connection, internal or external, and typically present a
 * certificate not in Node's default trust store. Local/Docker Postgres has
 * no SSL listener at all, so this only enables it for non-local hosts —
 * needed for `npm run seed` pointed at a deployed database from a laptop.
 */
export function sslConfigFor(connectionString: string): { rejectUnauthorized: boolean } | undefined {
  return /^postgres(?:ql)?:\/\/[^/]*@?(localhost|127\.0\.0\.1)/i.test(connectionString)
    ? undefined
    : { rejectUnauthorized: false };
}

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = env('DATABASE_URL');
    pool = new pg.Pool({
      connectionString,
      ssl: sslConfigFor(connectionString),
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    pool.on('error', (err) => {
      // Do not crash the process on idle-client errors (network blips).
      console.error('pg pool idle client error', err.message);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/** Runs fn inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
