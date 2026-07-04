/**
 * The money test: atomic claiming under contention. Many concurrent claimers
 * hammer the same queue; the invariants are (1) no job is ever claimed twice
 * and (2) the queue's max_concurrency cap is never exceeded.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  claimJobs,
  closePool,
  createJob,
  getPool,
  withTransaction,
} from '@pulse/core';
import { createFixture, createTestWorker } from './helpers';

afterAll(async () => {
  await closePool();
});

describe('atomic job claiming', () => {
  it('never hands the same job to two workers under heavy contention', async () => {
    const { projectId, queue } = await createFixture({ maxConcurrency: 1000 });
    const JOBS = 60;
    const CLAIMERS = 8;

    await withTransaction(async (client) => {
      for (let i = 0; i < JOBS; i++) {
        await createJob(client, { queueId: queue.id, projectId, type: 'demo.sleep', payload: { i } });
      }
    });
    const workers = await Promise.all(Array.from({ length: CLAIMERS }, () => createTestWorker()));

    // Every claimer loops until the queue is empty, all in parallel.
    const claimedBy = new Map<string, string>();
    let doubleClaims = 0;
    await Promise.all(
      workers.map(async (workerId) => {
        for (;;) {
          const jobs = await withTransaction((client) => claimJobs(client, workerId, 5, [queue.id]));
          if (jobs.length === 0) break;
          for (const job of jobs) {
            if (claimedBy.has(job.id)) doubleClaims++;
            claimedBy.set(job.id, workerId);
          }
        }
      }),
    );

    expect(doubleClaims).toBe(0);
    expect(claimedBy.size).toBe(JOBS);
    // Every claimed job carries exactly one attempt increment.
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM jobs WHERE queue_id = $1 AND status = 'claimed' AND attempt = 1`,
      [queue.id],
    );
    expect(rows[0].n).toBe(JOBS);
  });

  it('never exceeds the queue max_concurrency cap, even with parallel claimers', async () => {
    const CAP = 3;
    const { projectId, queue } = await createFixture({ maxConcurrency: CAP });
    await withTransaction(async (client) => {
      for (let i = 0; i < 20; i++) {
        await createJob(client, { queueId: queue.id, projectId, type: 'demo.sleep', payload: { i } });
      }
    });
    const workers = await Promise.all(Array.from({ length: 6 }, () => createTestWorker()));

    // Simultaneous burst: everyone asks for 10 jobs at once. Nothing is
    // completed in between, so total admissions must equal the cap.
    const results = await Promise.all(
      workers.map((workerId) => withTransaction((client) => claimJobs(client, workerId, 10, [queue.id]))),
    );
    const totalClaimed = results.reduce((sum, jobs) => sum + jobs.length, 0);
    expect(totalClaimed).toBe(CAP);

    // Second burst while the first CAP jobs are still in flight → zero slots.
    const second = await Promise.all(
      workers.map((workerId) => withTransaction((client) => claimJobs(client, workerId, 10, [queue.id]))),
    );
    expect(second.reduce((sum, jobs) => sum + jobs.length, 0)).toBe(0);
  });

  it('respects queue priority, then job priority, then FIFO', async () => {
    const { projectId, queue: lowQueue } = await createFixture();
    const { rows } = await getPool().query(
      `INSERT INTO queues (project_id, name, priority, max_concurrency) VALUES ($1, 'high-prio', 50, 10) RETURNING *`,
      [projectId],
    );
    const highQueue = rows[0];

    await withTransaction(async (client) => {
      await createJob(client, { queueId: lowQueue.id, projectId, type: 'a', priority: 999 });
      await createJob(client, { queueId: highQueue.id, projectId, type: 'b', priority: 0 });
      await createJob(client, { queueId: highQueue.id, projectId, type: 'c', priority: 10 });
    });

    const workerId = await createTestWorker();
    const claimed = await withTransaction((client) => claimJobs(client, workerId, 3, [lowQueue.id, highQueue.id]));
    // Higher-priority QUEUE wins over higher-priority JOB in a lower queue;
    // within the queue, job priority orders.
    expect(claimed.map((j) => j.type)).toEqual(['c', 'b', 'a']);
  });

  it('ignores paused queues and delayed jobs', async () => {
    const { projectId, queue } = await createFixture();
    await withTransaction(async (client) => {
      await createJob(client, { queueId: queue.id, projectId, type: 'now' });
      await createJob(client, { queueId: queue.id, projectId, type: 'later', delayMs: 3_600_000 });
    });
    const workerId = await createTestWorker();

    await getPool().query(`UPDATE queues SET is_paused = true WHERE id = $1`, [queue.id]);
    expect(await withTransaction((c) => claimJobs(c, workerId, 10, [queue.id]))).toHaveLength(0);

    await getPool().query(`UPDATE queues SET is_paused = false WHERE id = $1`, [queue.id]);
    const claimed = await withTransaction((c) => claimJobs(c, workerId, 10, [queue.id]));
    // Only the immediate job — the delayed one is status='scheduled'.
    expect(claimed.map((j) => j.type)).toEqual(['now']);
  });
});
