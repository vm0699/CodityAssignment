import { loadEnv, env } from './env.js';
import { runMigrations } from './migrate.js';

loadEnv();
const applied = await runMigrations(env('DATABASE_URL'));
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
