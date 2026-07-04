import pg from 'pg';
import { env, loadEnv } from './env.js';

loadEnv();

// timestamptz columns come back as JS Dates by default — keep that, but parse
// bigint counts (used by aggregate queries) as numbers instead of strings.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export type Db = pg.Pool | pg.PoolClient;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: env('DATABASE_URL'),
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
