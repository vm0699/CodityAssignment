import type { Db } from '../db.js';
import { publishEvent } from '../events.js';
import type { LogLevel } from '../types.js';

export interface SystemEvent {
  id: number;
  level: LogLevel;
  component: string;
  message: string;
  context: Record<string, unknown> | null;
  created_at: Date;
}

/**
 * Records an infrastructure-level event and pushes it onto the live event
 * bus in the same call, so the dashboard's Activity page updates instantly
 * instead of waiting for its next poll. Never throws into the caller's
 * control flow — a logging failure must not fail the job/claim/tick it's
 * describing.
 */
export async function logSystemEvent(
  db: Db,
  input: { level?: LogLevel; component: string; message: string; context?: Record<string, unknown> },
): Promise<void> {
  try {
    const { rows } = await db.query(
      `INSERT INTO system_events (level, component, message, context) VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.level ?? 'info', input.component, input.message.slice(0, 2000), input.context ? JSON.stringify(input.context) : null],
    );
    await publishEvent(db, {
      kind: 'system.log',
      id: rows[0].id,
      level: input.level ?? 'info',
      component: input.component,
      message: input.message,
    });
  } catch {
    // best-effort — see docstring
  }
}

export async function listSystemEvents(
  db: Db,
  opts: { limit?: number; component?: string } = {},
): Promise<SystemEvent[]> {
  const params: unknown[] = [opts.limit ?? 200];
  const where = opts.component ? 'WHERE component = $2' : '';
  if (opts.component) params.push(opts.component);
  const { rows } = await db.query(
    `SELECT * FROM system_events ${where} ORDER BY id DESC LIMIT $1`,
    params,
  );
  return rows;
}

/** Keeps the feed bounded — same retention pattern as worker_heartbeats. */
export async function pruneSystemEvents(db: Db, olderThanHours: number): Promise<number> {
  const res = await db.query(
    `DELETE FROM system_events WHERE created_at < now() - ($1 || ' hours')::interval`,
    [olderThanHours],
  );
  return res.rowCount ?? 0;
}
