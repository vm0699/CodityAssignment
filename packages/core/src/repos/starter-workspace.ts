import type { Db } from '../db.js';
import { withTransaction } from '../db.js';
import { createJob } from './jobs.js';
import { createProject } from './projects.js';
import { createQueue } from './queues.js';
import { createRetryPolicy } from './retry-policies.js';
import { createScheduledJob } from './scheduled-jobs.js';

/**
 * Auto-provisions a populated starter project for every newly registered
 * account. Rationale: an evaluator (or any new user) who registers their own
 * account should see a working, populated dashboard immediately — not an
 * empty state that only the manually-seeded demo account has. This mirrors
 * packages/core/src/seed.ts's demo dataset but scoped per-registration, and
 * additionally inserts a handful of jobs with historical timestamps directly
 * (bypassing the normal claim/execute flow) so the Overview charts, job
 * pipeline, and Dead Letter Queue all have real data to show even if no
 * worker/scheduler process happens to be running yet.
 *
 * Failure here must never break registration — callers should catch and log
 * rather than propagate, since a fresh (empty) account is an acceptable
 * fallback if this fails.
 */
export async function provisionStarterWorkspace(
  db: Db,
  input: { orgId: string; userId: string },
): Promise<{ projectId: string }> {
  const { orgId, userId } = input;

  const project = await createProject(db, {
    orgId,
    name: 'Getting Started',
    slug: 'getting-started',
    description:
      'Auto-created starter workspace with sample queues, a retry policy, a cron schedule, and jobs in every lifecycle state — so there is something real to explore immediately. Rename or delete it any time.',
    createdBy: userId,
  });

  const policy = await createRetryPolicy(db, {
    projectId: project.id,
    name: 'standard-exponential',
    strategy: 'exponential',
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    jitterFactor: 0.2,
  });

  const critical = await createQueue(db, {
    projectId: project.id,
    name: 'critical',
    description: 'High-priority work',
    priority: 100,
    maxConcurrency: 10,
    retryPolicyId: policy.id,
  });
  const background = await createQueue(db, {
    projectId: project.id,
    name: 'background',
    description: 'General background jobs',
    priority: 10,
    maxConcurrency: 5,
    retryPolicyId: policy.id,
  });

  await createScheduledJob(db, {
    projectId: project.id,
    queueId: background.id,
    name: 'hourly-demo-report',
    cronExpression: '0 * * * *',
    jobType: 'demo.compute',
    payload: { iterations: 20 },
    createdBy: userId,
  });

  // --- Historical jobs, inserted directly with past timestamps, so the
  // throughput chart and KPIs are populated on first load regardless of
  // whether a worker happens to be running. ---
  const completedSpecs = [
    { minutesAgo: 24, durationMs: 320 },
    { minutesAgo: 19, durationMs: 540 },
    { minutesAgo: 14, durationMs: 210 },
    { minutesAgo: 9, durationMs: 780 },
    { minutesAgo: 4, durationMs: 410 },
  ];
  for (const spec of completedSpecs) {
    const { rows } = await db.query(
      `INSERT INTO jobs (queue_id, project_id, type, payload, status, priority, attempt, max_attempts,
                         run_at, timeout_ms, output, claimed_at, started_at, finished_at, created_at, created_by)
       VALUES ($1,$2,'demo.compute','{"iterations":20}','completed',0,1,3,
               now() - ($3 || ' minutes')::interval, 60000, '{"result":"ok"}',
               now() - ($3 || ' minutes')::interval,
               now() - ($3 || ' minutes')::interval,
               now() - ($3 || ' minutes')::interval + ($4 || ' milliseconds')::interval,
               now() - ($3 || ' minutes')::interval, $5)
       RETURNING id`,
      [background.id, project.id, spec.minutesAgo, spec.durationMs, userId],
    );
    await db.query(
      `INSERT INTO job_executions (job_id, attempt, status, started_at, finished_at, duration_ms, output)
       VALUES ($1, 1, 'completed',
               now() - ($2 || ' minutes')::interval,
               now() - ($2 || ' minutes')::interval + ($3::text || ' milliseconds')::interval,
               $3::int, '{"result":"ok"}')`,
      [rows[0].id, spec.minutesAgo, spec.durationMs],
    );
  }

  // One permanently failed job, already in the Dead Letter Queue, so the DLQ
  // page and the pipeline's dead-letter branch have something real to show
  // (and something to demo the "requeue" action on).
  const { rows: dlqRows } = await db.query(
    `INSERT INTO jobs (queue_id, project_id, type, payload, status, priority, attempt, max_attempts,
                       run_at, timeout_ms, last_error, failure_summary,
                       claimed_at, started_at, finished_at, created_at, created_by)
     VALUES ($1,$2,'demo.flaky','{"failureRate":1}','dead_letter',0,2,2,
             now() - interval '18 minutes', 60000,
             'Error: Simulated transient failure (failureRate=1)',
             'Job ''demo.flaky'' exhausted 2 attempt(s). This is a demo job that failed by design (simulated failure rate). Nothing to fix.',
             now() - interval '18 minutes', now() - interval '18 minutes', now() - interval '17 minutes 40 seconds',
             now() - interval '18 minutes', $3)
     RETURNING id`,
    [critical.id, project.id, userId],
  );
  const dlqJobId = dlqRows[0].id;
  await db.query(
    `INSERT INTO job_executions (job_id, attempt, status, started_at, finished_at, duration_ms, error) VALUES
       ($1, 1, 'failed', now() - interval '18 minutes', now() - interval '17 minutes 50 seconds', 10000, 'Simulated transient failure (failureRate=1)'),
       ($1, 2, 'failed', now() - interval '17 minutes 45 seconds', now() - interval '17 minutes 40 seconds', 5000, 'Simulated transient failure (failureRate=1)')`,
    [dlqJobId],
  );
  await db.query(
    `INSERT INTO dead_letter_jobs (job_id, queue_id, project_id, reason, error, failure_summary, attempts_made, payload_snapshot)
     VALUES ($1, $2, $3, 'Exhausted 2 attempts', 'Simulated transient failure (failureRate=1)',
             'This is a demo job that failed by design (simulated failure rate). Nothing to fix.', 2, '{"failureRate":1}')`,
    [dlqJobId, critical.id, project.id],
  );

  // --- Live jobs: real ones, created through the normal path, that an
  // actual worker (if one is running) will claim and process for real. ---
  await withTransaction(async (client) => {
    await createJob(client, { queueId: critical.id, projectId: project.id, type: 'demo.compute', payload: { iterations: 15 }, createdBy: userId });
    await createJob(client, { queueId: background.id, projectId: project.id, type: 'email.send', payload: { to: 'you@example.com', template: 'welcome' }, createdBy: userId });
    await createJob(client, { queueId: critical.id, projectId: project.id, type: 'demo.flaky', payload: { failureRate: 0.5 }, createdBy: userId });
  });

  return { projectId: project.id };
}
