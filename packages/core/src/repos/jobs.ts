import type pg from 'pg';
import type { Db } from '../db.js';
import { withTransaction } from '../db.js';
import { publishEvent, publishWake } from '../events.js';
import { computeBackoffMs } from '../retry.js';
import { logSystemEvent } from './system-events.js';
import type { Job, JobStatus } from '../types.js';
import { DEFAULT_RETRY_POLICY } from '../types.js';

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface CreateJobInput {
  queueId: string;
  projectId: string;
  type: string;
  payload?: Record<string, unknown>;
  priority?: number;
  /** Delay in ms or absolute time; either puts the job in 'scheduled'. */
  delayMs?: number;
  runAt?: Date;
  timeoutMs?: number;
  maxAttempts?: number;
  idempotencyKey?: string;
  batchId?: string;
  scheduledJobId?: string;
  /** Parent job ids — the job waits until all of them complete. */
  dependsOn?: string[];
  createdBy?: string;
}

/**
 * Inserts a job. Immediate jobs go straight to 'queued'; delayed/scheduled
 * jobs and jobs with dependencies start as 'scheduled'. If an idempotency key
 * collides, the existing job is returned instead (deduplication).
 */
export async function createJob(client: pg.PoolClient, input: CreateJobInput): Promise<{ job: Job; deduplicated: boolean }> {
  const runAt = input.runAt ?? (input.delayMs ? new Date(Date.now() + input.delayMs) : new Date());
  const dependsOn = [...new Set(input.dependsOn ?? [])];

  if (dependsOn.length > 0) {
    // Lock parents so none can complete between the "which parents are still
    // open" count and the edge insert — otherwise a child could wait forever.
    const { rows: parents } = await client.query(
      `SELECT id, status, project_id FROM jobs WHERE id = ANY($1::uuid[]) FOR UPDATE`,
      [dependsOn],
    );
    if (parents.length !== dependsOn.length) {
      throw new DependencyError('One or more dependency jobs do not exist');
    }
    for (const p of parents) {
      if (p.project_id !== input.projectId) throw new DependencyError('Dependencies must belong to the same project');
      if (['failed', 'dead_letter', 'cancelled'].includes(p.status)) {
        throw new DependencyError(`Dependency ${p.id} is in terminal failure state '${p.status}'`);
      }
    }
    const pendingCount = parents.filter((p) => p.status !== 'completed').length;

    const job = await insertJob(client, input, runAt, pendingCount > 0 ? 'scheduled' : statusFor(runAt), pendingCount);
    if (job.deduplicated) return job;
    for (const parentId of dependsOn) {
      await client.query(
        `INSERT INTO job_dependencies (job_id, depends_on_job_id) VALUES ($1, $2)`,
        [job.job.id, parentId],
      );
    }
    return job;
  }

  return insertJob(client, input, runAt, statusFor(runAt), 0);
}

export class DependencyError extends Error {}

function statusFor(runAt: Date): JobStatus {
  return runAt.getTime() > Date.now() + 250 ? 'scheduled' : 'queued';
}

async function insertJob(
  client: pg.PoolClient,
  input: CreateJobInput,
  runAt: Date,
  status: JobStatus,
  pendingDependencies: number,
): Promise<{ job: Job; deduplicated: boolean }> {
  const { rows } = await client.query(
    `INSERT INTO jobs (queue_id, project_id, scheduled_job_id, batch_id, type, payload, status,
                       priority, max_attempts, run_at, timeout_ms, idempotency_key,
                       pending_dependencies, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (queue_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      input.queueId,
      input.projectId,
      input.scheduledJobId ?? null,
      input.batchId ?? null,
      input.type,
      JSON.stringify(input.payload ?? {}),
      status,
      input.priority ?? 0,
      input.maxAttempts ?? null,
      runAt,
      input.timeoutMs ?? 60_000,
      input.idempotencyKey ?? null,
      pendingDependencies,
      input.createdBy ?? null,
    ],
  );
  if (rows[0]) {
    await publishEvent(client, { kind: 'job.created', projectId: input.projectId, jobId: rows[0].id, queueId: input.queueId, status });
    if (status === 'queued') await publishWake(client);
    return { job: rows[0], deduplicated: false };
  }
  // Idempotency-key conflict: return the existing job.
  const { rows: existing } = await client.query(
    `SELECT * FROM jobs WHERE queue_id = $1 AND idempotency_key = $2`,
    [input.queueId, input.idempotencyKey],
  );
  return { job: existing[0], deduplicated: true };
}

// ---------------------------------------------------------------------------
// Listing / detail
// ---------------------------------------------------------------------------

export interface JobFilters {
  projectId: string;
  queueId?: string;
  statuses?: JobStatus[];
  type?: string;
  batchId?: string;
  scheduledJobId?: string;
  workerId?: string;
  createdAfter?: Date;
  createdBefore?: Date;
  /** matches job id prefix or type substring */
  search?: string;
  limit: number;
  offset: number;
}

export async function listJobs(db: Db, f: JobFilters): Promise<{ jobs: Job[]; total: number }> {
  const where: string[] = ['j.project_id = $1'];
  const params: unknown[] = [f.projectId];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (f.queueId) add('j.queue_id = ?', f.queueId);
  if (f.statuses?.length) add('j.status = ANY(?::job_status[])', f.statuses);
  if (f.type) add('j.type = ?', f.type);
  if (f.batchId) add('j.batch_id = ?', f.batchId);
  if (f.scheduledJobId) add('j.scheduled_job_id = ?', f.scheduledJobId);
  if (f.workerId) add('j.worker_id = ?', f.workerId);
  if (f.createdAfter) add('j.created_at >= ?', f.createdAfter);
  if (f.createdBefore) add('j.created_at <= ?', f.createdBefore);
  if (f.search) {
    params.push(f.search);
    // one param referenced twice: id prefix match OR type substring match
    where.push(`(j.id::text ILIKE $${params.length} || '%' OR j.type ILIKE '%' || $${params.length} || '%')`);
  }
  const whereSql = where.join(' AND ');

  const totalRes = await db.query(`SELECT count(*)::int AS n FROM jobs j WHERE ${whereSql}`, params);
  const { rows } = await db.query(
    `SELECT j.*, q.name AS queue_name FROM jobs j JOIN queues q ON q.id = j.queue_id
      WHERE ${whereSql}
      ORDER BY j.created_at DESC
      LIMIT ${f.limit} OFFSET ${f.offset}`,
    params,
  );
  return { jobs: rows, total: totalRes.rows[0].n };
}

export async function getJobById(db: Db, id: string): Promise<(Job & { queue_name?: string }) | null> {
  const { rows } = await db.query(
    `SELECT j.*, q.name AS queue_name FROM jobs j JOIN queues q ON q.id = j.queue_id WHERE j.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function getJobDependencies(
  db: Db,
  jobId: string,
): Promise<{ dependsOn: Array<{ id: string; status: JobStatus; type: string }>; dependents: Array<{ id: string; status: JobStatus; type: string }> }> {
  const dependsOn = await db.query(
    `SELECT p.id, p.status, p.type FROM job_dependencies d JOIN jobs p ON p.id = d.depends_on_job_id WHERE d.job_id = $1`,
    [jobId],
  );
  const dependents = await db.query(
    `SELECT c.id, c.status, c.type FROM job_dependencies d JOIN jobs c ON c.id = d.job_id WHERE d.depends_on_job_id = $1`,
    [jobId],
  );
  return { dependsOn: dependsOn.rows, dependents: dependents.rows };
}

// ---------------------------------------------------------------------------
// Atomic claiming — the concurrency-critical path
// ---------------------------------------------------------------------------

/**
 * Advisory lock serialising claim transactions. Claims are single fast
 * UPDATEs (~1ms), so serialising them costs little and buys *exact*
 * per-queue concurrency-cap and rate-limit enforcement (no two claimers can
 * over-admit a queue by reading the same snapshot). Scaling path: shard this
 * lock per queue id. Full discussion in docs/DESIGN-DECISIONS.md.
 */
const CLAIM_LOCK_KEY = 0x504c434c; // "PLCL"

/**
 * Atomically claims up to `limit` runnable jobs for a worker.
 *
 *  - runnable: status='queued', run_at due, queue not paused
 *  - honours queue priority over job priority, then FIFO by run_at
 *  - per-queue admission window = min(free concurrency slots, rate-limit slots)
 *  - FOR UPDATE SKIP LOCKED + status guard make double-claiming impossible
 *    even if the advisory lock were removed
 */
export async function claimJobs(
  client: pg.PoolClient,
  workerId: string,
  limit: number,
  queueFilter: string[] | null = null,
): Promise<Job[]> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [CLAIM_LOCK_KEY]);
  const { rows } = await client.query(
    `WITH runnable AS (
       SELECT j.id, j.queue_id, j.priority, j.run_at, j.created_at,
              q.priority AS queue_priority,
              row_number() OVER (
                PARTITION BY j.queue_id
                ORDER BY j.priority DESC, j.run_at ASC, j.created_at ASC
              ) AS rn,
              q.max_concurrency
                - (SELECT count(*)::int FROM jobs r
                    WHERE r.queue_id = j.queue_id AND r.status IN ('claimed','running')) AS conc_slots,
              CASE WHEN q.rate_limit_per_second IS NULL THEN 2147483647
                   ELSE q.rate_limit_per_second
                     - (SELECT count(*)::int FROM jobs r
                         WHERE r.queue_id = j.queue_id AND r.claimed_at > now() - interval '1 second')
              END AS rate_slots
         FROM jobs j
         JOIN queues q ON q.id = j.queue_id
        WHERE j.status = 'queued'
          AND j.run_at <= now()
          AND q.is_paused = false
          AND ($3::uuid[] IS NULL OR j.queue_id = ANY($3))
     ),
     picked AS (
       SELECT id,
              row_number() OVER (
                ORDER BY queue_priority DESC, priority DESC, run_at ASC, created_at ASC
              ) AS pick_order
         FROM runnable
        WHERE rn <= LEAST(conc_slots, rate_slots)
        ORDER BY queue_priority DESC, priority DESC, run_at ASC, created_at ASC
        LIMIT $2
     ),
     locked AS (
       SELECT id FROM jobs
        WHERE id IN (SELECT id FROM picked) AND status = 'queued'
        FOR UPDATE SKIP LOCKED
     ),
     updated AS (
       UPDATE jobs j
          SET status = 'claimed',
              worker_id = $1,
              claimed_at = now(),
              attempt = j.attempt + 1
         FROM locked l
        WHERE j.id = l.id
        RETURNING j.*
     )
     -- UPDATE ... RETURNING does not preserve the priority order computed
     -- above, so re-join to "picked" and sort explicitly by that order.
     SELECT u.* FROM updated u JOIN picked p ON p.id = u.id ORDER BY p.pick_order`,
    [workerId, limit, queueFilter],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Lifecycle transitions (all guarded by current status in the WHERE clause)
// ---------------------------------------------------------------------------

export async function markJobRunning(db: Db, jobId: string, workerId: string): Promise<Job | null> {
  const { rows } = await db.query(
    `UPDATE jobs SET status = 'running', started_at = now()
      WHERE id = $1 AND status = 'claimed' AND worker_id = $2
      RETURNING *`,
    [jobId, workerId],
  );
  if (rows[0]) {
    await publishEvent(db, { kind: 'job.updated', projectId: rows[0].project_id, jobId, queueId: rows[0].queue_id, status: 'running' });
  }
  return rows[0] ?? null;
}

/**
 * Completes a job and releases dependents: each child's pending_dependencies
 * is decremented; children reaching 0 are promoted (queued if due, otherwise
 * left scheduled for the scheduler to promote at run_at).
 */
export async function completeJob(
  jobId: string,
  workerId: string,
  output: Record<string, unknown> | null,
): Promise<Job | null> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE jobs SET status = 'completed', finished_at = now(), output = $3
        WHERE id = $1 AND status = 'running' AND worker_id = $2
        RETURNING *`,
      [jobId, workerId, output ? JSON.stringify(output) : null],
    );
    const job: Job | undefined = rows[0];
    if (!job) return null;

    const released = await releaseDependents(client, jobId);
    await publishEvent(client, { kind: 'job.updated', projectId: job.project_id, jobId, queueId: job.queue_id, status: 'completed' });
    if (released > 0) await publishWake(client);
    return job;
  });
}

/** Decrement children counters; promote any that become fully unblocked. Returns promoted count. */
export async function releaseDependents(client: pg.PoolClient, parentJobId: string): Promise<number> {
  const { rows: children } = await client.query(
    `UPDATE jobs c
        SET pending_dependencies = c.pending_dependencies - 1
       FROM job_dependencies d
      WHERE d.depends_on_job_id = $1 AND d.job_id = c.id AND c.pending_dependencies > 0
      RETURNING c.id, c.pending_dependencies, c.run_at, c.status`,
    [parentJobId],
  );
  let promoted = 0;
  for (const child of children) {
    if (child.pending_dependencies === 0 && child.status === 'scheduled' && new Date(child.run_at) <= new Date()) {
      const res = await client.query(
        `UPDATE jobs SET status = 'queued' WHERE id = $1 AND status = 'scheduled' RETURNING project_id, queue_id`,
        [child.id],
      );
      if (res.rows[0]) {
        promoted++;
        await publishEvent(client, { kind: 'job.updated', projectId: res.rows[0].project_id, jobId: child.id, queueId: res.rows[0].queue_id, status: 'queued' });
      }
    }
  }
  return promoted;
}

export interface FailureOutcome {
  outcome: 'retry_scheduled' | 'dead_letter';
  job: Job;
  nextRunAt?: Date;
}

/**
 * Records a failed attempt and decides what happens next based on the queue's
 * retry policy: schedule a backoff retry, or move to the Dead Letter Queue
 * and cascade-cancel dependent jobs.
 */
export async function failJob(
  jobId: string,
  workerId: string | null,
  error: string,
  failureSummary: string | null,
): Promise<FailureOutcome | null> {
  return withTransaction(async (client) => {
    const guard = workerId ? `AND worker_id = $2` : '';
    const params: unknown[] = workerId ? [jobId, workerId] : [jobId];
    const { rows } = await client.query(
      `UPDATE jobs SET status = 'failed', finished_at = now(), last_error = $${params.length + 1}
        WHERE id = $1 AND status IN ('running', 'claimed') ${guard}
        RETURNING *`,
      [...params, error.slice(0, 8000)],
    );
    const job: Job | undefined = rows[0];
    if (!job) return null;

    // Resolve the effective retry policy: queue policy or system default;
    // job-level max_attempts overrides the policy's.
    const { rows: policyRows } = await client.query(
      `SELECT p.* FROM queues q LEFT JOIN retry_policies p ON p.id = q.retry_policy_id WHERE q.id = $1`,
      [job.queue_id],
    );
    const policy = policyRows[0]?.id ? policyRows[0] : null;
    const maxAttempts = job.max_attempts ?? policy?.max_attempts ?? DEFAULT_RETRY_POLICY.max_attempts;

    if (job.attempt < maxAttempts) {
      const delayMs = computeBackoffMs(
        {
          strategy: policy?.strategy ?? DEFAULT_RETRY_POLICY.strategy,
          baseDelayMs: policy?.base_delay_ms ?? DEFAULT_RETRY_POLICY.base_delay_ms,
          maxDelayMs: policy?.max_delay_ms ?? DEFAULT_RETRY_POLICY.max_delay_ms,
          jitterFactor: policy?.jitter_factor ?? DEFAULT_RETRY_POLICY.jitter_factor,
        },
        job.attempt,
      );
      const nextRunAt = new Date(Date.now() + delayMs);
      const upd = await client.query(
        `UPDATE jobs SET status = 'scheduled', run_at = $2, worker_id = NULL
          WHERE id = $1 AND status = 'failed' RETURNING *`,
        [jobId, nextRunAt],
      );
      await publishEvent(client, { kind: 'job.updated', projectId: job.project_id, jobId, queueId: job.queue_id, status: 'scheduled' });
      return { outcome: 'retry_scheduled', job: upd.rows[0], nextRunAt };
    }

    // Attempts exhausted → Dead Letter Queue.
    const upd = await client.query(
      `UPDATE jobs SET status = 'dead_letter', failure_summary = COALESCE($2, failure_summary)
        WHERE id = $1 AND status = 'failed' RETURNING *`,
      [jobId, failureSummary],
    );
    await client.query(
      `INSERT INTO dead_letter_jobs (job_id, queue_id, project_id, reason, error, failure_summary, attempts_made, payload_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [jobId, job.queue_id, job.project_id, `Exhausted ${maxAttempts} attempts`, error.slice(0, 8000), failureSummary, job.attempt, JSON.stringify(job.payload)],
    );
    await cancelDependentsCascade(client, jobId, `dependency ${jobId} entered the dead letter queue`);
    await publishEvent(client, { kind: 'job.updated', projectId: job.project_id, jobId, queueId: job.queue_id, status: 'dead_letter' });
    await publishEvent(client, { kind: 'dlq.updated', projectId: job.project_id, jobId, queueId: job.queue_id });
    await logSystemEvent(client, {
      level: 'error',
      component: 'reliability.dlq',
      message: `Job ${jobId.slice(0, 8)} (${job.type}) exhausted ${maxAttempts} attempt(s) — moved to Dead Letter Queue`,
      context: { jobId, queueId: job.queue_id, attempts: job.attempt },
    });
    return { outcome: 'dead_letter', job: upd.rows[0] };
  });
}

/** Recursively cancels every not-yet-finished descendant of a failed/cancelled job. */
export async function cancelDependentsCascade(client: pg.PoolClient, rootJobId: string, reason: string): Promise<number> {
  const { rows } = await client.query(
    `WITH RECURSIVE descendants AS (
       SELECT d.job_id FROM job_dependencies d WHERE d.depends_on_job_id = $1
       UNION
       SELECT d.job_id FROM job_dependencies d JOIN descendants x ON d.depends_on_job_id = x.job_id
     )
     UPDATE jobs SET status = 'cancelled', finished_at = now(), last_error = $2
      WHERE id IN (SELECT job_id FROM descendants)
        AND status IN ('scheduled', 'queued')
      RETURNING id, project_id, queue_id`,
    [rootJobId, reason],
  );
  for (const r of rows) {
    await publishEvent(client, { kind: 'job.updated', projectId: r.project_id, jobId: r.id, queueId: r.queue_id, status: 'cancelled' });
  }
  return rows.length;
}

export async function cancelJob(jobId: string): Promise<Job | null> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE jobs SET status = 'cancelled', finished_at = now()
        WHERE id = $1 AND status IN ('scheduled', 'queued', 'claimed', 'running')
        RETURNING *`,
      [jobId],
    );
    const job: Job | undefined = rows[0];
    if (!job) return null;
    await cancelDependentsCascade(client, jobId, `dependency ${jobId} was cancelled`);
    await publishEvent(client, { kind: 'job.updated', projectId: job.project_id, jobId, queueId: job.queue_id, status: 'cancelled' });
    return job;
  });
}

/** Manual "retry now": puts a failed/dead-letter/cancelled job straight back on the queue. */
export async function retryJobNow(jobId: string, requeuedBy?: string): Promise<Job | null> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE jobs
          SET status = 'queued', run_at = now(), worker_id = NULL,
              last_error = NULL, finished_at = NULL, output = NULL
        WHERE id = $1 AND status IN ('failed', 'dead_letter', 'cancelled', 'scheduled')
        RETURNING *`,
      [jobId],
    );
    const job: Job | undefined = rows[0];
    if (!job) return null;
    // Close out the active DLQ entry, if any (kept as audit history).
    const dlqClosed = await client.query(
      `UPDATE dead_letter_jobs SET requeued_at = now(), requeued_by = $2
        WHERE job_id = $1 AND requeued_at IS NULL`,
      [jobId, requeuedBy ?? null],
    );
    if ((dlqClosed.rowCount ?? 0) > 0) {
      await logSystemEvent(client, {
        component: 'reliability.dlq',
        message: `Job ${jobId.slice(0, 8)} (${job.type}) manually requeued from the Dead Letter Queue`,
        context: { jobId, queueId: job.queue_id },
      });
    }
    await publishEvent(client, { kind: 'job.updated', projectId: job.project_id, jobId, queueId: job.queue_id, status: 'queued' });
    await publishWake(client);
    return job;
  });
}

// ---------------------------------------------------------------------------
// Reaper — crash recovery
// ---------------------------------------------------------------------------

/**
 * Requeues in-flight jobs held by workers whose heartbeat lease expired, and
 * marks those workers dead. This is what turns "a worker was OOM-killed" into
 * "the job ran again somewhere else" instead of "the job hung forever".
 * Returns the requeued job ids.
 */
export async function requeueOrphanedJobs(client: pg.PoolClient, leaseTimeoutMs: number): Promise<string[]> {
  const { rows: deadWorkers } = await client.query(
    `UPDATE workers SET status = 'dead'
      WHERE status IN ('online', 'draining')
        AND last_heartbeat_at < now() - ($1 || ' milliseconds')::interval
      RETURNING id`,
    [leaseTimeoutMs],
  );
  if (deadWorkers.length === 0) return [];

  const ids = deadWorkers.map((w) => w.id);
  const { rows } = await client.query(
    `UPDATE jobs
        SET status = 'queued', worker_id = NULL, claimed_at = NULL, started_at = NULL
      WHERE worker_id = ANY($1::uuid[]) AND status IN ('claimed', 'running')
      RETURNING id, project_id, queue_id, attempt`,
    [ids],
  );
  for (const job of rows) {
    await client.query(
      `UPDATE job_executions SET status = 'interrupted', finished_at = now(),
              error = 'worker lease expired; job requeued by reaper'
        WHERE job_id = $1 AND attempt = $2 AND status = 'running'`,
      [job.id, job.attempt],
    );
    await publishEvent(client, { kind: 'job.updated', projectId: job.project_id, jobId: job.id, queueId: job.queue_id, status: 'queued' });
  }
  for (const workerId of ids) {
    await publishEvent(client, { kind: 'worker.updated', workerId, status: 'dead' });
  }
  if (rows.length > 0) {
    await publishWake(client);
    await logSystemEvent(client, {
      level: 'warn',
      component: 'reliability.reaper',
      message: `Reaper detected ${ids.length} dead worker(s) (missed heartbeat lease) — requeued ${rows.length} orphaned job(s)`,
      context: { deadWorkerIds: ids, requeuedJobIds: rows.map((r) => r.id) },
    });
  }
  return rows.map((r) => r.id);
}
