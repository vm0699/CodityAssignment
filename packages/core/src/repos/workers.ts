import type { Db } from '../db.js';
import { publishEvent } from '../events.js';
import type { WorkerRow, WorkerStatus } from '../types.js';

export async function registerWorker(
  db: Db,
  input: { name: string; hostname: string; pid: number; concurrency: number; queueFilter?: string[] | null },
): Promise<WorkerRow> {
  const { rows } = await db.query(
    `INSERT INTO workers (name, hostname, pid, concurrency, queue_filter)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.name, input.hostname, input.pid, input.concurrency, input.queueFilter ?? null],
  );
  await publishEvent(db, { kind: 'worker.updated', workerId: rows[0].id, status: 'online' });
  return rows[0];
}

export async function recordHeartbeat(db: Db, workerId: string, runningJobs: number, memoryMb: number): Promise<void> {
  await db.query(`UPDATE workers SET last_heartbeat_at = now() WHERE id = $1`, [workerId]);
  await db.query(
    `INSERT INTO worker_heartbeats (worker_id, running_jobs, memory_mb) VALUES ($1, $2, $3)`,
    [workerId, runningJobs, memoryMb],
  );
}

export async function setWorkerStatus(db: Db, workerId: string, status: WorkerStatus): Promise<void> {
  await db.query(
    `UPDATE workers SET status = $2, stopped_at = CASE WHEN $2 IN ('offline','dead') THEN now() ELSE stopped_at END
      WHERE id = $1`,
    [workerId, status],
  );
  await publishEvent(db, { kind: 'worker.updated', workerId, status });
}

export interface WorkerView extends WorkerRow {
  running_jobs: number;
  seconds_since_heartbeat: number;
}

/** Workers with live in-flight counts. Includes recently stopped ones for context. */
export async function listWorkers(db: Db): Promise<WorkerView[]> {
  const { rows } = await db.query(
    `SELECT w.*,
            (SELECT count(*)::int FROM jobs j WHERE j.worker_id = w.id AND j.status IN ('claimed','running')) AS running_jobs,
            extract(epoch FROM (now() - w.last_heartbeat_at))::int AS seconds_since_heartbeat
       FROM workers w
      WHERE w.status IN ('online', 'draining')
         OR w.last_heartbeat_at > now() - interval '24 hours'
      ORDER BY w.status, w.started_at DESC`,
  );
  return rows;
}

/** Trim heartbeat history so the table cannot grow unbounded. */
export async function pruneHeartbeats(db: Db, olderThanHours: number): Promise<number> {
  const res = await db.query(
    `DELETE FROM worker_heartbeats WHERE created_at < now() - ($1 || ' hours')::interval`,
    [olderThanHours],
  );
  return res.rowCount ?? 0;
}
