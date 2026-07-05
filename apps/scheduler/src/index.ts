import os from 'node:os';
import pg from 'pg';
import { closePool, createLogger, env, envInt, getPool, loadEnv, logSystemEvent, runMigrations } from '@pulse/core';
import { materialiseCronSchedules, promoteDueJobs } from './tick.js';

loadEnv();
const log = createLogger({ component: 'scheduler' });

const TICK_MS = envInt('SCHEDULER_TICK_MS', 1000);
// Session-level advisory lock: exactly one scheduler instance in the cluster
// does work; the rest hot-standby and take over the moment the leader's
// connection dies (Postgres releases the lock automatically).
const LEADER_LOCK_KEY = 0x50534348; // "PSCH"

if (process.env.RUN_MIGRATIONS !== 'false') {
  await runMigrations(env('DATABASE_URL'));
}

let leaderClient: pg.Client | null = null;
let running = true;
let isLeader = false;

async function tryBecomeLeader(): Promise<boolean> {
  try {
    if (!leaderClient) {
      leaderClient = new pg.Client({ connectionString: env('DATABASE_URL') });
      leaderClient.on('error', () => {
        // Connection lost — leadership is gone with it.
        isLeader = false;
        leaderClient?.end().catch(() => undefined);
        leaderClient = null;
      });
      await leaderClient.connect();
    }
    const { rows } = await leaderClient.query('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_LOCK_KEY]);
    return rows[0].ok === true;
  } catch (err) {
    log.warn('leader election attempt failed', { error: (err as Error).message });
    leaderClient?.end().catch(() => undefined);
    leaderClient = null;
    return false;
  }
}

async function mainLoop(): Promise<void> {
  log.info('scheduler starting (standby until leadership acquired)');
  while (running) {
    if (!isLeader) {
      isLeader = await tryBecomeLeader();
      if (isLeader) {
        log.info('acquired leadership — this instance is now active');
        void logSystemEvent(getPool(), {
          component: 'scheduler.leader-election',
          message: `Scheduler instance pid=${process.pid} on ${os.hostname()} acquired leadership via pg_advisory_lock (active singleton; other replicas hot-standby)`,
          context: { pid: process.pid, hostname: os.hostname() },
        });
      } else {
        await sleep(2000);
        continue;
      }
    }
    try {
      const promoted = await promoteDueJobs();
      const fired = await materialiseCronSchedules();
      if (promoted || fired) log.debug('tick', { promoted, fired });
    } catch (err) {
      log.error('tick failed', { error: (err as Error).message });
    }
    await sleep(TICK_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} received — stopping`);
  running = false;
  await leaderClient?.end().catch(() => undefined);
  await closePool();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await mainLoop();
