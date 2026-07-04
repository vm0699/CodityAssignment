/**
 * Full job lifecycle: execution records, retry backoff per policy, dead
 * lettering after exhausted attempts, DLQ requeue, dependency workflows,
 * and reaper crash-recovery.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  cancelJob,
  claimJobs,
  closePool,
  completeJob,
  createJob,
  createRetryPolicy,
  failJob,
  getJobById,
  getPool,
  listDeadLetterJobs,
  markJobRunning,
  requeueOrphanedJobs,
  retryJobNow,
  withTransaction,
} from '@pulse/core';
import { executeJob } from '../../apps/worker/src/executor';
import { promoteDueJobs } from '../../apps/scheduler/src/tick';
import { createFixture, createTestWorker } from './helpers';

afterAll(async () => {
  await closePool();
});

async function claimOne(workerId: string, queueId: string) {
  const jobs = await withTransaction((c) => claimJobs(c, workerId, 1, [queueId]));
  expect(jobs).toHaveLength(1);
  return jobs[0];
}

describe('job lifecycle', () => {
  it('walks the happy path with a real handler: queued → claimed → running → completed', async () => {
    const { projectId, queue } = await createFixture();
    const workerId = await createTestWorker();
    const { job } = await withTransaction((c) =>
      createJob(c, { queueId: queue.id, projectId, type: 'demo.sleep', payload: { ms: 10 } }),
    );

    const claimed = await claimOne(workerId, queue.id);
    expect(claimed.id).toBe(job.id);
    await executeJob(claimed, workerId);

    const done = await getJobById(getPool(), job.id);
    expect(done?.status).toBe('completed');
    expect(done?.output).toEqual({ sleptMs: 10 });

    const { rows: execs } = await getPool().query(
      `SELECT * FROM job_executions WHERE job_id = $1`, [job.id]);
    expect(execs).toHaveLength(1);
    expect(execs[0].status).toBe('completed');
    expect(execs[0].duration_ms).toBeGreaterThanOrEqual(0);

    const { rows: logs } = await getPool().query(
      `SELECT * FROM job_logs WHERE job_id = $1 ORDER BY id`, [job.id]);
    expect(logs.length).toBeGreaterThanOrEqual(2); // started + completed
  });

  it('schedules retries with exponential backoff, then dead-letters, then requeues from the DLQ', async () => {
    const { projectId, queue, project } = await createFixture();
    const policy = await createRetryPolicy(getPool(), {
      projectId: project.id, name: 'test-exp', strategy: 'exponential',
      maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 600_000,
    });
    await getPool().query(`UPDATE queues SET retry_policy_id = $2 WHERE id = $1`, [queue.id, policy.id]);
    const workerId = await createTestWorker();

    const { job } = await withTransaction((c) =>
      createJob(c, { queueId: queue.id, projectId, type: 'demo.fail', payload: { message: 'boom' } }),
    );

    // Attempt 1 → retry in ~60s
    let claimed = await claimOne(workerId, queue.id);
    await markJobRunning(getPool(), claimed.id, workerId);
    let outcome = await failJob(claimed.id, workerId, 'boom', null);
    expect(outcome?.outcome).toBe('retry_scheduled');
    const delta1 = outcome!.nextRunAt!.getTime() - Date.now();
    expect(delta1).toBeGreaterThan(50_000);
    expect(delta1).toBeLessThan(70_000);

    // Make it due now, promote via the scheduler, attempt 2 → retry in ~120s
    await getPool().query(`UPDATE jobs SET run_at = now() WHERE id = $1`, [job.id]);
    expect(await promoteDueJobs()).toBeGreaterThanOrEqual(1);
    claimed = await claimOne(workerId, queue.id);
    expect(claimed.attempt).toBe(2);
    await markJobRunning(getPool(), claimed.id, workerId);
    outcome = await failJob(claimed.id, workerId, 'boom again', null);
    expect(outcome?.outcome).toBe('retry_scheduled');
    const delta2 = outcome!.nextRunAt!.getTime() - Date.now();
    expect(delta2).toBeGreaterThan(110_000);
    expect(delta2).toBeLessThan(130_000);

    // Attempt 3 → attempts exhausted → dead letter
    await getPool().query(`UPDATE jobs SET run_at = now() WHERE id = $1`, [job.id]);
    await promoteDueJobs();
    claimed = await claimOne(workerId, queue.id);
    expect(claimed.attempt).toBe(3);
    await markJobRunning(getPool(), claimed.id, workerId);
    outcome = await failJob(claimed.id, workerId, 'final boom', 'it kept exploding');
    expect(outcome?.outcome).toBe('dead_letter');

    const { entries } = await listDeadLetterJobs(getPool(), { projectId, limit: 10, offset: 0 });
    expect(entries).toHaveLength(1);
    expect(entries[0].job_id).toBe(job.id);
    expect(entries[0].attempts_made).toBe(3);
    expect(entries[0].failure_summary).toBe('it kept exploding');

    // Manual requeue from the DLQ
    const requeued = await retryJobNow(job.id);
    expect(requeued?.status).toBe('queued');
    const { entries: after } = await listDeadLetterJobs(getPool(), { projectId, limit: 10, offset: 0 });
    expect(after).toHaveLength(0); // active entry closed out
  });

  it('runs a real failing handler through the executor into the DLQ', async () => {
    const { projectId, queue } = await createFixture();
    const workerId = await createTestWorker();
    await withTransaction((c) =>
      createJob(c, {
        queueId: queue.id, projectId, type: 'demo.fail',
        payload: { message: 'deterministic failure' }, maxAttempts: 2,
      }),
    );

    // Drive claim → execute → (retry due) until terminal, like a worker would.
    for (let i = 0; i < 2; i++) {
      const jobs = await withTransaction((c) => claimJobs(c, workerId, 1, [queue.id]));
      expect(jobs).toHaveLength(1);
      await executeJob(jobs[0], workerId);
      await getPool().query(`UPDATE jobs SET run_at = now() WHERE id = $1 AND status = 'scheduled'`, [jobs[0].id]);
      await promoteDueJobs();
    }

    const { entries } = await listDeadLetterJobs(getPool(), { projectId, limit: 10, offset: 0 });
    expect(entries).toHaveLength(1);
    expect(entries[0].failure_summary).toMatch(/exhausted 2 attempt/i);
  });

  it('enforces job timeouts', async () => {
    const { projectId, queue } = await createFixture();
    const workerId = await createTestWorker();
    await withTransaction((c) =>
      createJob(c, {
        queueId: queue.id, projectId, type: 'demo.sleep',
        payload: { ms: 5000 }, timeoutMs: 200, maxAttempts: 1,
      }),
    );
    const jobs = await withTransaction((c) => claimJobs(c, workerId, 1, [queue.id]));
    await executeJob(jobs[0], workerId);

    const job = await getJobById(getPool(), jobs[0].id);
    expect(job?.status).toBe('dead_letter');
    const { rows } = await getPool().query(`SELECT status FROM job_executions WHERE job_id = $1`, [jobs[0].id]);
    expect(rows[0].status).toBe('timed_out');
  });
});

describe('workflow dependencies', () => {
  it('holds children until parents complete, then releases them', async () => {
    const { projectId, queue } = await createFixture();
    const workerId = await createTestWorker();

    const { parent, child } = await withTransaction(async (c) => {
      const { job: parent } = await createJob(c, { queueId: queue.id, projectId, type: 'demo.sleep', payload: { ms: 5 } });
      const { job: child } = await createJob(c, {
        queueId: queue.id, projectId, type: 'demo.sleep', payload: { ms: 5 }, dependsOn: [parent.id],
      });
      return { parent, child };
    });

    expect(child.status).toBe('scheduled');
    expect(child.pending_dependencies).toBe(1);

    // Only the parent is claimable.
    const claimed = await withTransaction((c) => claimJobs(c, workerId, 10, [queue.id]));
    expect(claimed.map((j) => j.id)).toEqual([parent.id]);

    await markJobRunning(getPool(), parent.id, workerId);
    await completeJob(parent.id, workerId, null);

    const released = await getJobById(getPool(), child.id);
    expect(released?.status).toBe('queued');
    expect(released?.pending_dependencies).toBe(0);
  });

  it('cascade-cancels descendants when a parent is cancelled or dead-lettered', async () => {
    const { projectId, queue } = await createFixture();
    const ids = await withTransaction(async (c) => {
      const { job: a } = await createJob(c, { queueId: queue.id, projectId, type: 't' });
      const { job: b } = await createJob(c, { queueId: queue.id, projectId, type: 't', dependsOn: [a.id] });
      const { job: cJob } = await createJob(c, { queueId: queue.id, projectId, type: 't', dependsOn: [b.id] });
      return { a: a.id, b: b.id, c: cJob.id };
    });

    await cancelJob(ids.a);
    for (const id of [ids.b, ids.c]) {
      const job = await getJobById(getPool(), id);
      expect(job?.status).toBe('cancelled');
    }
  });

  it('rejects dependencies on already-failed jobs', async () => {
    const { projectId, queue } = await createFixture();
    const workerId = await createTestWorker();
    const { job: parent } = await withTransaction((c) =>
      createJob(c, { queueId: queue.id, projectId, type: 'demo.fail', maxAttempts: 1 }),
    );
    const jobs = await withTransaction((c) => claimJobs(c, workerId, 1, [queue.id]));
    await executeJob(jobs[0], workerId); // → dead_letter

    await expect(
      withTransaction((c) =>
        createJob(c, { queueId: queue.id, projectId, type: 't', dependsOn: [parent.id] }),
      ),
    ).rejects.toThrow(/terminal failure state/);
  });
});

describe('reaper crash recovery', () => {
  it('requeues in-flight jobs from workers with expired leases', async () => {
    const { projectId, queue } = await createFixture();
    const workerId = await createTestWorker();
    const { job } = await withTransaction((c) =>
      createJob(c, { queueId: queue.id, projectId, type: 'demo.sleep' }),
    );
    const claimed = await claimOne(workerId, queue.id);
    await markJobRunning(getPool(), claimed.id, workerId);
    await getPool().query(
      `INSERT INTO job_executions (job_id, attempt, worker_id, status) VALUES ($1, 1, $2, 'running')
       ON CONFLICT (job_id, attempt) DO NOTHING`,
      [job.id, workerId],
    );

    // Simulate a crashed worker: heartbeat far in the past.
    await getPool().query(`UPDATE workers SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [workerId]);
    const requeued = await withTransaction((c) => requeueOrphanedJobs(c, 30_000));
    expect(requeued).toContain(job.id);

    const recovered = await getJobById(getPool(), job.id);
    expect(recovered?.status).toBe('queued');
    expect(recovered?.worker_id).toBeNull();

    const { rows } = await getPool().query(`SELECT status FROM workers WHERE id = $1`, [workerId]);
    expect(rows[0].status).toBe('dead');
    const { rows: execs } = await getPool().query(
      `SELECT status FROM job_executions WHERE job_id = $1 AND attempt = 1`, [job.id]);
    expect(execs[0].status).toBe('interrupted');
  });

  it('leaves healthy workers alone', async () => {
    const { projectId, queue } = await createFixture();
    const workerId = await createTestWorker();
    await withTransaction((c) => createJob(c, { queueId: queue.id, projectId, type: 't' }));
    const claimed = await claimOne(workerId, queue.id);

    const requeued = await withTransaction((c) => requeueOrphanedJobs(c, 30_000));
    expect(requeued).not.toContain(claimed.id);
  });
});
