import {
  advanceSchedule,
  claimDueSchedules,
  createJob,
  createLogger,
  nextCronOccurrence,
  publishEvent,
  publishWake,
  withTransaction,
} from '@pulse/core';

const log = createLogger({ component: 'scheduler' });

/** Stage 1: promote due delayed/scheduled/retry-waiting jobs to 'queued'. */
export async function promoteDueJobs(): Promise<number> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE jobs SET status = 'queued'
        WHERE status = 'scheduled' AND run_at <= now() AND pending_dependencies = 0
        RETURNING id, project_id, queue_id`,
    );
    for (const job of rows) {
      await publishEvent(client, {
        kind: 'job.updated',
        projectId: job.project_id,
        jobId: job.id,
        queueId: job.queue_id,
        status: 'queued',
      });
    }
    if (rows.length > 0) await publishWake(client);
    return rows.length;
  });
}

/**
 * Stage 2: materialise due cron schedules into concrete job rows and advance
 * next_run_at. No catch-up backfill: if the scheduler was down for an hour, a
 * minutely schedule fires once, not sixty times (documented trade-off).
 */
export async function materialiseCronSchedules(): Promise<number> {
  return withTransaction(async (client) => {
    const due = await claimDueSchedules(client, 100);
    for (const schedule of due) {
      await createJob(client, {
        queueId: schedule.queue_id,
        projectId: schedule.project_id,
        scheduledJobId: schedule.id,
        type: schedule.job_type,
        payload: schedule.payload,
        priority: schedule.priority,
        timeoutMs: schedule.timeout_ms,
        maxAttempts: schedule.max_attempts ?? undefined,
        // One live instance per schedule per fire-time; a duplicate
        // materialisation collapses via the idempotency index.
        idempotencyKey: `cron:${schedule.id}:${schedule.next_run_at.toISOString()}`,
      });
      const next = nextCronOccurrence(schedule.cron_expression, schedule.timezone, new Date());
      await advanceSchedule(client, schedule.id, next);
      log.info(`fired schedule '${schedule.name}'`, { next: next.toISOString() });
    }
    return due.length;
  });
}
