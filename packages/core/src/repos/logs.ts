import type { Db } from '../db.js';
import type { JobLog, LogLevel } from '../types.js';

export async function appendJobLog(
  db: Db,
  input: {
    jobId: string;
    executionId?: string | null;
    workerId?: string | null;
    level?: LogLevel;
    message: string;
    context?: Record<string, unknown> | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO job_logs (job_id, execution_id, worker_id, level, message, context)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.jobId,
      input.executionId ?? null,
      input.workerId ?? null,
      input.level ?? 'info',
      input.message.slice(0, 10_000),
      input.context ? JSON.stringify(input.context) : null,
    ],
  );
}

export async function listJobLogs(
  db: Db,
  jobId: string,
  opts: { afterId?: number; limit?: number } = {},
): Promise<JobLog[]> {
  const { rows } = await db.query(
    `SELECT * FROM job_logs
      WHERE job_id = $1 AND id > $2
      ORDER BY id ASC
      LIMIT $3`,
    [jobId, opts.afterId ?? 0, opts.limit ?? 500],
  );
  return rows;
}
