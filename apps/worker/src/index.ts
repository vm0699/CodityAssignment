import os from 'node:os';
import {
  claimJobs,
  closePool,
  createLogger,
  env,
  envInt,
  getPool,
  loadEnv,
  logSystemEvent,
  pruneHeartbeats,
  pruneSystemEvents,
  recordHeartbeat,
  registerWorker,
  requeueOrphanedJobs,
  runMigrations,
  setWorkerStatus,
  startHealthServer,
  startKeepAlivePing,
  subscribe,
  WAKE_CHANNEL,
  withTransaction,
} from '@pulse/core';
import { executeJob } from './executor.js';

loadEnv();
const log = createLogger({ component: 'worker' });

const CONCURRENCY = envInt('WORKER_CONCURRENCY', 5);
const POLL_INTERVAL_MS = envInt('WORKER_POLL_INTERVAL_MS', 1000);
const HEARTBEAT_INTERVAL_MS = envInt('WORKER_HEARTBEAT_INTERVAL_MS', 5000);
const LEASE_TIMEOUT_MS = envInt('WORKER_LEASE_TIMEOUT_MS', 30_000);
const REAPER_INTERVAL_MS = 10_000;
// Optional comma-separated queue uuid filter (queue sharding across workers).
const QUEUE_FILTER = process.env.WORKER_QUEUE_FILTER?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
// Serialise the reaper across workers — one sweep at a time is plenty.
const REAPER_LOCK_KEY = 0x50524150; // "PRAP"

if (process.env.RUN_MIGRATIONS !== 'false') {
  await runMigrations(env('DATABASE_URL'));
}

// Free-tier PaaS hosting (Render, etc.) only keeps "web service" deployments
// alive perpetually, which requires binding to $PORT. The worker has no HTTP
// API of its own, so this is purely a platform-compatibility health endpoint
// — see packages/core/src/keepalive.ts and docs/DEPLOYMENT.md.
if (process.env.PORT) startHealthServer(Number(process.env.PORT));
if (process.env.RENDER_EXTERNAL_URL) startKeepAlivePing(process.env.RENDER_EXTERNAL_URL);

const worker = await registerWorker(getPool(), {
  name: process.env.WORKER_NAME ?? `worker-${os.hostname()}-${process.pid}`,
  hostname: os.hostname(),
  pid: process.pid,
  concurrency: CONCURRENCY,
  queueFilter: QUEUE_FILTER,
});
log.info(`worker ${worker.name} registered`, { id: worker.id, concurrency: CONCURRENCY });
void logSystemEvent(getPool(), {
  component: 'worker.lifecycle',
  message: `Worker ${worker.name} registered (concurrency=${CONCURRENCY}${QUEUE_FILTER ? `, sharded to ${QUEUE_FILTER.length} queue(s)` : ''})`,
  context: { workerId: worker.id, concurrency: CONCURRENCY, queueFilter: QUEUE_FILTER },
});

const inFlight = new Set<Promise<void>>();
let draining = false;

// --- Wake-up: LISTEN gives sub-second dispatch, the poll interval is only a fallback ---
let wakeResolve: (() => void) | null = null;
const wakeSubscription = await subscribe(WAKE_CHANNEL, () => {
  wakeResolve?.();
  wakeResolve = null;
});

function sleepUntilWake(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeResolve = null;
      resolve();
    }, ms);
    wakeResolve = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

// --- Heartbeats (worker liveness lease) ---
const heartbeatTimer = setInterval(() => {
  void recordHeartbeat(getPool(), worker.id, inFlight.size, Math.round(process.memoryUsage().rss / 1_048_576)).catch(
    (err) => log.warn('heartbeat failed', { error: (err as Error).message }),
  );
}, HEARTBEAT_INTERVAL_MS);

// --- Reaper: recover jobs orphaned by dead workers (advisory-locked, any worker can run it) ---
const reaperTimer = setInterval(() => {
  void withTransaction(async (client) => {
    const { rows } = await client.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [REAPER_LOCK_KEY]);
    if (!rows[0].locked) return;
    const requeued = await requeueOrphanedJobs(client, LEASE_TIMEOUT_MS);
    if (requeued.length) log.warn(`reaper requeued ${requeued.length} orphaned job(s)`, { jobIds: requeued });
  }).catch((err) => log.warn('reaper sweep failed', { error: (err as Error).message }));
}, REAPER_INTERVAL_MS);

// --- Housekeeping: keep heartbeat history and the activity feed bounded ---
const pruneTimer = setInterval(() => {
  void pruneHeartbeats(getPool(), 24).catch(() => undefined);
  void pruneSystemEvents(getPool(), 24).catch(() => undefined);
}, 600_000);

// --- Main claim/execute loop ---
async function mainLoop(): Promise<void> {
  while (!draining) {
    const freeSlots = CONCURRENCY - inFlight.size;
    let claimed = 0;
    if (freeSlots > 0) {
      try {
        const jobs = await withTransaction((client) => claimJobs(client, worker.id, freeSlots, QUEUE_FILTER));
        claimed = jobs.length;
        for (const job of jobs) {
          const promise = executeJob(job, worker.id)
            .catch((err) => log.error('executor crashed', { jobId: job.id, error: (err as Error).message }))
            .finally(() => inFlight.delete(promise));
          inFlight.add(promise);
        }
        if (claimed > 0) {
          log.info(`claimed ${claimed} job(s)`, { inFlight: inFlight.size });
          void logSystemEvent(getPool(), {
            component: 'concurrency.claim',
            message: `Worker ${worker.name.slice(0, 24)} atomically claimed ${claimed} job(s) (SKIP LOCKED) — ${inFlight.size}/${CONCURRENCY} slots busy`,
            context: { workerId: worker.id, claimed, jobIds: jobs.map((j) => j.id) },
          });
        }
      } catch (err) {
        log.error('claim cycle failed', { error: (err as Error).message });
      }
    }
    if (claimed === 0) {
      // Nothing runnable (or saturated): sleep until the poll interval or a
      // NOTIFY wake-up, whichever comes first.
      await sleepUntilWake(inFlight.size >= CONCURRENCY ? 250 : POLL_INTERVAL_MS);
    }
  }
}

// --- Graceful shutdown: stop claiming, drain in-flight jobs, deregister ---
async function shutdown(signal: string): Promise<void> {
  if (draining) return;
  draining = true;
  log.info(`${signal} received — draining ${inFlight.size} in-flight job(s)`);
  clearInterval(heartbeatTimer);
  clearInterval(reaperTimer);
  clearInterval(pruneTimer);
  await setWorkerStatus(getPool(), worker.id, 'draining').catch(() => undefined);
  await logSystemEvent(getPool(), {
    component: 'worker.lifecycle',
    message: `Worker ${worker.name} received ${signal} — draining ${inFlight.size} in-flight job(s) gracefully`,
    context: { workerId: worker.id, inFlight: inFlight.size },
  }).catch(() => undefined);

  const DRAIN_TIMEOUT_MS = envInt('WORKER_DRAIN_TIMEOUT_MS', 30_000);
  const drained = await Promise.race([
    Promise.allSettled([...inFlight]).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS)),
  ]);
  if (!drained) {
    log.warn('drain timeout exceeded; remaining jobs will be requeued by the reaper');
  }

  await setWorkerStatus(getPool(), worker.id, 'offline').catch(() => undefined);
  await logSystemEvent(getPool(), {
    component: 'worker.lifecycle',
    message: `Worker ${worker.name} stopped cleanly${drained ? '' : ' (drain timeout — any still-running job will be recovered by the reaper)'}`,
    context: { workerId: worker.id },
  }).catch(() => undefined);
  await wakeSubscription.close();
  await closePool();
  log.info('worker stopped cleanly');
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await mainLoop();
