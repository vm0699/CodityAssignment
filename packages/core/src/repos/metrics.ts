import type { Db } from '../db.js';

export interface OverviewMetrics {
  status_counts: Record<string, number>;
  jobs_last_hour: number;
  completed_last_hour: number;
  failed_attempts_last_hour: number;
  dead_letter_active: number;
  workers_online: number;
  avg_duration_ms_1h: number | null;
  p95_duration_ms_1h: number | null;
  oldest_queued_age_seconds: number | null;
}

export async function getOverviewMetrics(db: Db, projectId: string): Promise<OverviewMetrics> {
  const statusRes = await db.query(
    `SELECT status, count(*)::int AS n FROM jobs WHERE project_id = $1 GROUP BY status`,
    [projectId],
  );
  const status_counts: Record<string, number> = {};
  for (const row of statusRes.rows) status_counts[row.status] = row.n;

  const { rows } = await db.query(
    `SELECT
       (SELECT count(*)::int FROM jobs WHERE project_id = $1 AND created_at > now() - interval '1 hour') AS jobs_last_hour,
       (SELECT count(*)::int FROM jobs WHERE project_id = $1 AND status = 'completed' AND finished_at > now() - interval '1 hour') AS completed_last_hour,
       (SELECT count(*)::int FROM job_executions e JOIN jobs j ON j.id = e.job_id
         WHERE j.project_id = $1 AND e.status IN ('failed','timed_out') AND e.finished_at > now() - interval '1 hour') AS failed_attempts_last_hour,
       (SELECT count(*)::int FROM dead_letter_jobs WHERE project_id = $1 AND requeued_at IS NULL) AS dead_letter_active,
       (SELECT count(*)::int FROM workers WHERE status = 'online') AS workers_online,
       (SELECT avg(e.duration_ms)::float FROM job_executions e JOIN jobs j ON j.id = e.job_id
         WHERE j.project_id = $1 AND e.finished_at > now() - interval '1 hour') AS avg_duration_ms_1h,
       (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY e.duration_ms)::float
          FROM job_executions e JOIN jobs j ON j.id = e.job_id
         WHERE j.project_id = $1 AND e.finished_at > now() - interval '1 hour' AND e.duration_ms IS NOT NULL) AS p95_duration_ms_1h,
       (SELECT extract(epoch FROM (now() - min(run_at)))::int FROM jobs
         WHERE project_id = $1 AND status = 'queued' AND run_at <= now()) AS oldest_queued_age_seconds`,
    [projectId],
  );
  return { status_counts, ...rows[0] };
}

export interface ThroughputPoint {
  bucket: Date;
  completed: number;
  failed: number;
  created: number;
}

/**
 * Time-series for the dashboard chart: jobs created / completed / failed per
 * bucket over a trailing window. generate_series fills empty buckets so the
 * chart never has holes.
 */
export async function getThroughputSeries(
  db: Db,
  projectId: string,
  windowMinutes: number,
  bucketSeconds: number,
): Promise<ThroughputPoint[]> {
  const { rows } = await db.query(
    `WITH buckets AS (
       SELECT generate_series(
         date_trunc('second', now()) - ($2 || ' minutes')::interval,
         date_trunc('second', now()),
         ($3 || ' seconds')::interval
       ) AS bucket
     )
     SELECT b.bucket,
            (SELECT count(*)::int FROM jobs j
              WHERE j.project_id = $1 AND j.status = 'completed'
                AND j.finished_at >= b.bucket AND j.finished_at < b.bucket + ($3 || ' seconds')::interval) AS completed,
            (SELECT count(*)::int FROM job_executions e JOIN jobs j ON j.id = e.job_id
              WHERE j.project_id = $1 AND e.status IN ('failed','timed_out')
                AND e.finished_at >= b.bucket AND e.finished_at < b.bucket + ($3 || ' seconds')::interval) AS failed,
            (SELECT count(*)::int FROM jobs j
              WHERE j.project_id = $1
                AND j.created_at >= b.bucket AND j.created_at < b.bucket + ($3 || ' seconds')::interval) AS created
       FROM buckets b
      ORDER BY b.bucket`,
    [projectId, windowMinutes, bucketSeconds],
  );
  return rows;
}
