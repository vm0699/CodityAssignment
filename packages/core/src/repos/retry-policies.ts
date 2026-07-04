import type { Db } from '../db.js';
import type { RetryPolicy } from '../types.js';

export async function createRetryPolicy(
  db: Db,
  input: {
    projectId: string;
    name: string;
    strategy: string;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitterFactor?: number;
  },
): Promise<RetryPolicy> {
  const { rows } = await db.query(
    `INSERT INTO retry_policies (project_id, name, strategy, max_attempts, base_delay_ms, max_delay_ms, jitter_factor)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [input.projectId, input.name, input.strategy, input.maxAttempts, input.baseDelayMs, input.maxDelayMs, input.jitterFactor ?? 0],
  );
  return rows[0];
}

export async function listRetryPolicies(db: Db, projectId: string): Promise<RetryPolicy[]> {
  const { rows } = await db.query(
    `SELECT * FROM retry_policies WHERE project_id = $1 ORDER BY created_at`,
    [projectId],
  );
  return rows;
}

export async function getRetryPolicy(db: Db, id: string): Promise<RetryPolicy | null> {
  const { rows } = await db.query(`SELECT * FROM retry_policies WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function updateRetryPolicy(
  db: Db,
  id: string,
  patch: Partial<{ name: string; strategy: string; maxAttempts: number; baseDelayMs: number; maxDelayMs: number; jitterFactor: number }>,
): Promise<RetryPolicy | null> {
  const { rows } = await db.query(
    `UPDATE retry_policies SET
        name          = COALESCE($2, name),
        strategy      = COALESCE($3, strategy),
        max_attempts  = COALESCE($4, max_attempts),
        base_delay_ms = COALESCE($5, base_delay_ms),
        max_delay_ms  = COALESCE($6, max_delay_ms),
        jitter_factor = COALESCE($7, jitter_factor)
      WHERE id = $1 RETURNING *`,
    [id, patch.name ?? null, patch.strategy ?? null, patch.maxAttempts ?? null, patch.baseDelayMs ?? null, patch.maxDelayMs ?? null, patch.jitterFactor ?? null],
  );
  return rows[0] ?? null;
}

export async function deleteRetryPolicy(db: Db, id: string): Promise<boolean> {
  const res = await db.query(`DELETE FROM retry_policies WHERE id = $1`, [id]);
  return (res.rowCount ?? 0) > 0;
}
