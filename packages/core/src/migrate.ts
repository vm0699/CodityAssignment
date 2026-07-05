import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sslConfigFor } from './db.js';
import { createLogger } from './logger.js';
import { logSystemEvent } from './repos/system-events.js';

const log = createLogger({ component: 'migrate' });

// Migrations live at <core package root>/migrations — one folder above src/.
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

// Arbitrary constant; all Pulse processes agree on it so concurrent boots
// (api + worker + scheduler racing to migrate) serialize cleanly.
const MIGRATION_LOCK_KEY = 0x50_55_4c_53; // "PULS"

/**
 * Applies pending .sql migrations in filename order. Safe to run from every
 * service on boot: an advisory lock serializes runners and the
 * schema_migrations ledger makes it idempotent.
 */
export async function runMigrations(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl, ssl: sslConfigFor(databaseUrl) });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const done = new Set(
      (await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string),
    );
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      log.info(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    // system_events exists by now on any run that reaches this point (it is
    // itself created by 002_system_events.sql, applied earlier in this loop
    // on a fresh database).
    if (applied.length > 0) {
      await logSystemEvent(client, {
        component: 'migrate',
        message: `Applied migration(s): ${applied.join(', ')}`,
        context: { count: applied.length },
      });
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
  return applied;
}
