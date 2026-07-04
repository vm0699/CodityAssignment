/** One-time integration setup: migrate the test database from scratch. */
import pg from 'pg';
import { loadEnv, runMigrations } from '@pulse/core';

export default async function setup(): Promise<void> {
  loadEnv();
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://pulse:pulse@localhost:5433/pulse_test';
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach the test database at ${url}.\n` +
        `Start it with:  docker compose up -d db\n` +
        `(original error: ${(err as Error).message})`,
    );
  }
  // Full reset: drop and recreate the public schema, then migrate.
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
  await runMigrations(url);
}
