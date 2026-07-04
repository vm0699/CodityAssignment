import type { Db } from '../db.js';
import type { DeadLetterJob } from '../types.js';

export interface DlqFilters {
  projectId: string;
  queueId?: string;
  includeRequeued?: boolean;
  limit: number;
  offset: number;
}

export async function listDeadLetterJobs(
  db: Db,
  f: DlqFilters,
): Promise<{ entries: Array<DeadLetterJob & { job_type: string; queue_name: string }>; total: number }> {
  const where: string[] = ['d.project_id = $1'];
  const params: unknown[] = [f.projectId];
  if (f.queueId) {
    params.push(f.queueId);
    where.push(`d.queue_id = $${params.length}`);
  }
  if (!f.includeRequeued) where.push('d.requeued_at IS NULL');
  const whereSql = where.join(' AND ');

  const totalRes = await db.query(`SELECT count(*)::int AS n FROM dead_letter_jobs d WHERE ${whereSql}`, params);
  const { rows } = await db.query(
    `SELECT d.*, j.type AS job_type, q.name AS queue_name
       FROM dead_letter_jobs d
       JOIN jobs j ON j.id = d.job_id
       JOIN queues q ON q.id = d.queue_id
      WHERE ${whereSql}
      ORDER BY d.moved_at DESC
      LIMIT ${f.limit} OFFSET ${f.offset}`,
    params,
  );
  return { entries: rows, total: totalRes.rows[0].n };
}

export async function getDeadLetterEntry(db: Db, id: string): Promise<DeadLetterJob | null> {
  const { rows } = await db.query(`SELECT * FROM dead_letter_jobs WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** Permanently delete a dead job and its audit trail (destructive, RBAC-gated). */
export async function purgeDeadLetterJob(db: Db, entryId: string): Promise<boolean> {
  const entry = await getDeadLetterEntry(db, entryId);
  if (!entry || entry.requeued_at) return false;
  // Cascades to dead_letter_jobs, executions, and logs.
  const res = await db.query(`DELETE FROM jobs WHERE id = $1 AND status = 'dead_letter'`, [entry.job_id]);
  return (res.rowCount ?? 0) > 0;
}
