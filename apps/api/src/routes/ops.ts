import { Router } from 'express';
import {
  getDeadLetterEntry,
  getOverviewMetrics,
  getPool,
  getThroughputSeries,
  listDeadLetterJobs,
  listWorkers,
  purgeDeadLetterJob,
  retryJobNow,
} from '@pulse/core';
import { assertProjectRole, requireAuth, type AuthedRequest } from '../auth.js';
import { ApiError, asyncHandler } from '../errors.js';
import { paginationQuery, throughputQuery } from '../validate.js';

// --- Workers (platform-wide infrastructure view) ---

export const workersRouter = Router();
workersRouter.use(requireAuth);

workersRouter.get(
  '/',
  asyncHandler<AuthedRequest>(async (_req, res) => {
    res.json({ data: await listWorkers(getPool()) });
  }),
);

// --- Dead Letter Queue ---

export const projectDlqRouter = Router();
projectDlqRouter.use(requireAuth);

projectDlqRouter.get(
  '/:projectId/dlq',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const q = paginationQuery.parse(req.query);
    await assertProjectRole(req.userId, req.params.projectId, 'viewer');
    const { entries, total } = await listDeadLetterJobs(getPool(), {
      projectId: req.params.projectId,
      queueId: typeof req.query.queueId === 'string' ? req.query.queueId : undefined,
      includeRequeued: req.query.includeRequeued === 'true',
      limit: q.limit,
      offset: q.offset,
    });
    res.json({ data: entries, pagination: { total, limit: q.limit, offset: q.offset } });
  }),
);

export const dlqRouter = Router();
dlqRouter.use(requireAuth);

dlqRouter.post(
  '/:entryId/requeue',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const entry = await getDeadLetterEntry(getPool(), req.params.entryId);
    if (!entry) throw ApiError.notFound('Dead letter entry');
    await assertProjectRole(req.userId, entry.project_id, 'member');
    if (entry.requeued_at) throw ApiError.conflict('This entry was already requeued');
    const job = await retryJobNow(entry.job_id, req.userId);
    if (!job) throw ApiError.conflict('The underlying job is no longer in a requeueable state');
    res.json(job);
  }),
);

dlqRouter.delete(
  '/:entryId',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const entry = await getDeadLetterEntry(getPool(), req.params.entryId);
    if (!entry) throw ApiError.notFound('Dead letter entry');
    // Destructive: deletes the job and its history — admin only.
    await assertProjectRole(req.userId, entry.project_id, 'admin');
    const purged = await purgeDeadLetterJob(getPool(), entry.id);
    if (!purged) throw ApiError.conflict('Entry is not purgeable (already requeued?)');
    res.status(204).end();
  }),
);

// --- Metrics ---

export const metricsRouter = Router();
metricsRouter.use(requireAuth);

metricsRouter.get(
  '/:projectId/metrics/overview',
  asyncHandler<AuthedRequest>(async (req, res) => {
    await assertProjectRole(req.userId, req.params.projectId, 'viewer');
    res.json(await getOverviewMetrics(getPool(), req.params.projectId));
  }),
);

metricsRouter.get(
  '/:projectId/metrics/throughput',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const q = throughputQuery.parse(req.query);
    await assertProjectRole(req.userId, req.params.projectId, 'viewer');
    res.json({ data: await getThroughputSeries(getPool(), req.params.projectId, q.windowMinutes, q.bucketSeconds) });
  }),
);
