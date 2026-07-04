import type { Db } from '../db.js';
import type { Queue } from '../types.js';

export interface QueueStats {
  queue_id: string;
  scheduled: number;
  queued: number;
  claimed: number;
  running: number;
  completed: number;
  failed: number;
  dead_letter: number;
  cancelled: number;
  /** completed / (completed + dead_letter), last 24h; null when no data */
  success_rate_24h: number | null;
  avg_duration_ms_24h: number | null;
}

export async function createQueue(
  db: Db,
  input: {
    projectId: string;
    name: string;
    description?: string;
    priority?: number;
    maxConcurrency?: number;
    retryPolicyId?: string | null;
    rateLimitPerSecond?: number | null;
  },
): Promise<Queue> {
  const { rows } = await db.query(
    `INSERT INTO queues (project_id, name, description, priority, max_concurrency, retry_policy_id, rate_limit_per_second)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      input.projectId,
      input.name,
      input.description ?? '',
      input.priority ?? 0,
      input.maxConcurrency ?? 10,
      input.retryPolicyId ?? null,
      input.rateLimitPerSecond ?? null,
    ],
  );
  return rows[0];
}

export async function listQueues(db: Db, projectId: string): Promise<Queue[]> {
  const { rows } = await db.query(
    `SELECT * FROM queues WHERE project_id = $1 ORDER BY priority DESC, name`,
    [projectId],
  );
  return rows;
}

export async function getQueueById(db: Db, id: string): Promise<Queue | null> {
  const { rows } = await db.query(`SELECT * FROM queues WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function updateQueue(
  db: Db,
  id: string,
  patch: Partial<{
    name: string;
    description: string;
    priority: number;
    maxConcurrency: number;
    retryPolicyId: string | null;
    rateLimitPerSecond: number | null;
  }>,
): Promise<Queue | null> {
  // COALESCE-style patch does not allow setting nullable columns back to NULL,
  // so nullable fields use explicit "provided" flags.
  const { rows } = await db.query(
    `UPDATE queues SET
        name            = COALESCE($2, name),
        description     = COALESCE($3, description),
        priority        = COALESCE($4, priority),
        max_concurrency = COALESCE($5, max_concurrency),
        retry_policy_id = CASE WHEN $6 THEN $7 ELSE retry_policy_id END,
        rate_limit_per_second = CASE WHEN $8 THEN $9 ELSE rate_limit_per_second END
      WHERE id = $1 RETURNING *`,
    [
      id,
      patch.name ?? null,
      patch.description ?? null,
      patch.priority ?? null,
      patch.maxConcurrency ?? null,
      'retryPolicyId' in patch,
      patch.retryPolicyId ?? null,
      'rateLimitPerSecond' in patch,
      patch.rateLimitPerSecond ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function setQueuePaused(db: Db, id: string, paused: boolean): Promise<Queue | null> {
  const { rows } = await db.query(
    `UPDATE queues SET is_paused = $2 WHERE id = $1 RETURNING *`,
    [id, paused],
  );
  return rows[0] ?? null;
}

export async function deleteQueue(db: Db, id: string): Promise<boolean> {
  const res = await db.query(`DELETE FROM queues WHERE id = $1`, [id]);
  return (res.rowCount ?? 0) > 0;
}

/** Per-queue status counts + 24h quality metrics, for one project. */
export async function getQueueStats(db: Db, projectId: string): Promise<QueueStats[]> {
  const { rows } = await db.query(
    `SELECT q.id AS queue_id,
            count(*) FILTER (WHERE j.status = 'scheduled')   AS scheduled,
            count(*) FILTER (WHERE j.status = 'queued')      AS queued,
            count(*) FILTER (WHERE j.status = 'claimed')     AS claimed,
            count(*) FILTER (WHERE j.status = 'running')     AS running,
            count(*) FILTER (WHERE j.status = 'completed')   AS completed,
            count(*) FILTER (WHERE j.status = 'failed')      AS failed,
            count(*) FILTER (WHERE j.status = 'dead_letter') AS dead_letter,
            count(*) FILTER (WHERE j.status = 'cancelled')   AS cancelled,
            CASE WHEN count(*) FILTER (WHERE j.finished_at > now() - interval '24 hours'
                                         AND j.status IN ('completed','dead_letter')) = 0 THEN NULL
                 ELSE round(
                   count(*) FILTER (WHERE j.status = 'completed' AND j.finished_at > now() - interval '24 hours')::numeric
                   / count(*) FILTER (WHERE j.finished_at > now() - interval '24 hours'
                                        AND j.status IN ('completed','dead_letter'))::numeric, 4)::float
            END AS success_rate_24h,
            (SELECT avg(e.duration_ms)::float FROM job_executions e
               JOIN jobs j2 ON j2.id = e.job_id
              WHERE j2.queue_id = q.id AND e.finished_at > now() - interval '24 hours'
            ) AS avg_duration_ms_24h
       FROM queues q
       LEFT JOIN jobs j ON j.queue_id = q.id
      WHERE q.project_id = $1
      GROUP BY q.id`,
    [projectId],
  );
  return rows;
}
