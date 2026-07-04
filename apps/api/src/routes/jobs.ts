import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import {
  cancelJob,
  createJob,
  getJobById,
  getJobDependencies,
  getPool,
  getQueueById,
  listExecutionsForJob,
  listJobLogs,
  listJobs,
  retryJobNow,
  withTransaction,
} from '@pulse/core';
import { assertProjectRole, requireAuth, type AuthedRequest } from '../auth.js';
import { ApiError, asyncHandler } from '../errors.js';
import { createBatchSchema, createJobSchema, jobListQuery, parseStatusList } from '../validate.js';

// --- Job creation, nested under queues ---

export const queueJobsRouter = Router();
queueJobsRouter.use(requireAuth);

queueJobsRouter.post(
  '/:queueId/jobs',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const body = createJobSchema.parse(req.body);
    const queue = await getQueueById(getPool(), req.params.queueId);
    if (!queue) throw ApiError.notFound('Queue');
    await assertProjectRole(req.userId, queue.project_id, 'member');
    const { job, deduplicated } = await withTransaction((client) =>
      createJob(client, {
        queueId: queue.id,
        projectId: queue.project_id,
        createdBy: req.userId,
        ...body,
      }),
    );
    res.status(deduplicated ? 200 : 201).json({ ...job, deduplicated });
  }),
);

queueJobsRouter.post(
  '/:queueId/jobs/batch',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const body = createBatchSchema.parse(req.body);
    const queue = await getQueueById(getPool(), req.params.queueId);
    if (!queue) throw ApiError.notFound('Queue');
    await assertProjectRole(req.userId, queue.project_id, 'member');
    const batchId = randomUUID();
    // One transaction: a batch is all-or-nothing.
    const jobs = await withTransaction(async (client) => {
      const created = [];
      for (const spec of body.jobs) {
        const { job } = await createJob(client, {
          queueId: queue.id,
          projectId: queue.project_id,
          batchId,
          createdBy: req.userId,
          ...spec,
        });
        created.push(job);
      }
      return created;
    });
    res.status(201).json({ batchId, count: jobs.length, jobs });
  }),
);

// --- Job exploration & actions ---

export const projectJobsRouter = Router();
projectJobsRouter.use(requireAuth);

projectJobsRouter.get(
  '/:projectId/jobs',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const q = jobListQuery.parse(req.query);
    await assertProjectRole(req.userId, req.params.projectId, 'viewer');
    const { jobs, total } = await listJobs(getPool(), {
      projectId: req.params.projectId,
      queueId: q.queueId,
      statuses: parseStatusList(q.status),
      type: q.type,
      batchId: q.batchId,
      scheduledJobId: q.scheduledJobId,
      workerId: q.workerId,
      search: q.search,
      createdAfter: q.createdAfter,
      createdBefore: q.createdBefore,
      limit: q.limit,
      offset: q.offset,
    });
    res.json({ data: jobs, pagination: { total, limit: q.limit, offset: q.offset } });
  }),
);

export const jobsRouter = Router();
jobsRouter.use(requireAuth);

async function loadJobChecked(userId: string, jobId: string, minRole: 'viewer' | 'member') {
  const job = await getJobById(getPool(), jobId);
  if (!job) throw ApiError.notFound('Job');
  await assertProjectRole(userId, job.project_id, minRole);
  return job;
}

jobsRouter.get(
  '/:jobId',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const job = await loadJobChecked(req.userId, req.params.jobId, 'viewer');
    const [executions, dependencies] = await Promise.all([
      listExecutionsForJob(getPool(), job.id),
      getJobDependencies(getPool(), job.id),
    ]);
    res.json({ ...job, executions, dependencies });
  }),
);

jobsRouter.get(
  '/:jobId/logs',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const job = await loadJobChecked(req.userId, req.params.jobId, 'viewer');
    const afterId = req.query.afterId ? Number.parseInt(String(req.query.afterId), 10) : 0;
    const logs = await listJobLogs(getPool(), job.id, { afterId: Number.isNaN(afterId) ? 0 : afterId });
    res.json({ data: logs });
  }),
);

jobsRouter.post(
  '/:jobId/cancel',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const job = await loadJobChecked(req.userId, req.params.jobId, 'member');
    const cancelled = await cancelJob(job.id);
    if (!cancelled) {
      throw ApiError.conflict(`Job is '${job.status}' and can no longer be cancelled`);
    }
    res.json(cancelled);
  }),
);

jobsRouter.post(
  '/:jobId/retry',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const job = await loadJobChecked(req.userId, req.params.jobId, 'member');
    const retried = await retryJobNow(job.id, req.userId);
    if (!retried) {
      throw ApiError.conflict(`Job is '${job.status}'; only failed, dead-letter, cancelled or scheduled jobs can be retried now`);
    }
    res.json(retried);
  }),
);
