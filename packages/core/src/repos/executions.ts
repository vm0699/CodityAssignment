import type { Db } from '../db.js';
import type { ExecutionStatus, JobExecution } from '../types.js';

export async function startExecution(
  db: Db,
  input: { jobId: string; attempt: number; workerId: string },
): Promise<JobExecution> {
  const { rows } = await db.query(
    `INSERT INTO job_executions (job_id, attempt, worker_id, status)
     VALUES ($1, $2, $3, 'running')
     ON CONFLICT (job_id, attempt) DO UPDATE SET worker_id = EXCLUDED.worker_id, status = 'running', started_at = now()
     RETURNING *`,
    [input.jobId, input.attempt, input.workerId],
  );
  return rows[0];
}

export async function finishExecution(
  db: Db,
  executionId: string,
  status: ExecutionStatus,
  result: { error?: string; output?: Record<string, unknown> | null },
): Promise<JobExecution | null> {
  const { rows } = await db.query(
    `UPDATE job_executions
        SET status = $2, finished_at = now(),
            duration_ms = (extract(epoch FROM (now() - started_at)) * 1000)::int,
            error = $3, output = $4
      WHERE id = $1 RETURNING *`,
    [executionId, status, result.error?.slice(0, 8000) ?? null, result.output ? JSON.stringify(result.output) : null],
  );
  return rows[0] ?? null;
}

export async function listExecutionsForJob(db: Db, jobId: string): Promise<JobExecution[]> {
  const { rows } = await db.query(
    `SELECT * FROM job_executions WHERE job_id = $1 ORDER BY attempt DESC`,
    [jobId],
  );
  return rows;
}
