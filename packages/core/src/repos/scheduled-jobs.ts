import type pg from 'pg';
import type { Db } from '../db.js';
import { nextCronOccurrence, validateCron } from '../cron.js';
import type { ScheduledJob } from '../types.js';

export async function createScheduledJob(
  db: Db,
  input: {
    projectId: string;
    queueId: string;
    name: string;
    cronExpression: string;
    timezone?: string;
    jobType: string;
    payload?: Record<string, unknown>;
    priority?: number;
    timeoutMs?: number;
    maxAttempts?: number | null;
    createdBy?: string;
  },
): Promise<ScheduledJob> {
  const tz = input.timezone ?? 'UTC';
  validateCron(input.cronExpression, tz);
  const nextRunAt = nextCronOccurrence(input.cronExpression, tz);
  const { rows } = await db.query(
    `INSERT INTO scheduled_jobs (project_id, queue_id, name, cron_expression, timezone, job_type,
                                 payload, priority, timeout_ms, max_attempts, next_run_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      input.projectId,
      input.queueId,
      input.name,
      input.cronExpression,
      tz,
      input.jobType,
      JSON.stringify(input.payload ?? {}),
      input.priority ?? 0,
      input.timeoutMs ?? 60_000,
      input.maxAttempts ?? null,
      nextRunAt,
      input.createdBy ?? null,
    ],
  );
  return rows[0];
}

export async function listScheduledJobs(db: Db, projectId: string): Promise<ScheduledJob[]> {
  const { rows } = await db.query(
    `SELECT * FROM scheduled_jobs WHERE project_id = $1 ORDER BY created_at`,
    [projectId],
  );
  return rows;
}

export async function getScheduledJob(db: Db, id: string): Promise<ScheduledJob | null> {
  const { rows } = await db.query(`SELECT * FROM scheduled_jobs WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function updateScheduledJob(
  db: Db,
  id: string,
  patch: Partial<{ name: string; cronExpression: string; timezone: string; payload: Record<string, unknown>; priority: number; status: 'active' | 'paused' }>,
): Promise<ScheduledJob | null> {
  const current = await getScheduledJob(db, id);
  if (!current) return null;
  const cron = patch.cronExpression ?? current.cron_expression;
  const tz = patch.timezone ?? current.timezone;
  validateCron(cron, tz);
  // Recompute next_run_at whenever the schedule itself changes.
  const scheduleChanged = patch.cronExpression !== undefined || patch.timezone !== undefined;
  const nextRunAt = scheduleChanged ? nextCronOccurrence(cron, tz) : current.next_run_at;
  const { rows } = await db.query(
    `UPDATE scheduled_jobs SET
        name = $2, cron_expression = $3, timezone = $4, payload = $5,
        priority = $6, status = $7, next_run_at = $8
      WHERE id = $1 RETURNING *`,
    [
      id,
      patch.name ?? current.name,
      cron,
      tz,
      JSON.stringify(patch.payload ?? current.payload),
      patch.priority ?? current.priority,
      patch.status ?? current.status,
      nextRunAt,
    ],
  );
  return rows[0] ?? null;
}

export async function deleteScheduledJob(db: Db, id: string): Promise<boolean> {
  const res = await db.query(`DELETE FROM scheduled_jobs WHERE id = $1`, [id]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Locks and returns schedules that are due. SKIP LOCKED lets a second
 * scheduler instance (split-brain window during failover) safely pass over
 * rows the leader is already materialising.
 */
export async function claimDueSchedules(client: pg.PoolClient, limit: number): Promise<ScheduledJob[]> {
  const { rows } = await client.query(
    `SELECT * FROM scheduled_jobs
      WHERE status = 'active' AND next_run_at <= now()
      ORDER BY next_run_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return rows;
}

export async function advanceSchedule(client: pg.PoolClient, id: string, nextRunAt: Date): Promise<void> {
  await client.query(
    `UPDATE scheduled_jobs SET next_run_at = $2, last_enqueued_at = now() WHERE id = $1`,
    [id, nextRunAt],
  );
}
