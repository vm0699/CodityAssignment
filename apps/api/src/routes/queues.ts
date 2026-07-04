import { Router } from 'express';
import {
  createQueue,
  deleteQueue,
  getPool,
  getQueueById,
  getQueueStats,
  listQueues,
  publishEvent,
  setQueuePaused,
  updateQueue,
} from '@pulse/core';
import { assertProjectRole, requireAuth, type AuthedRequest } from '../auth.js';
import { ApiError, asyncHandler } from '../errors.js';
import { createQueueSchema, updateQueueSchema } from '../validate.js';

export const projectQueuesRouter = Router();
projectQueuesRouter.use(requireAuth);

projectQueuesRouter.get(
  '/:projectId/queues',
  asyncHandler<AuthedRequest>(async (req, res) => {
    await assertProjectRole(req.userId, req.params.projectId, 'viewer');
    res.json({ data: await listQueues(getPool(), req.params.projectId) });
  }),
);

projectQueuesRouter.get(
  '/:projectId/queues/stats',
  asyncHandler<AuthedRequest>(async (req, res) => {
    await assertProjectRole(req.userId, req.params.projectId, 'viewer');
    res.json({ data: await getQueueStats(getPool(), req.params.projectId) });
  }),
);

projectQueuesRouter.post(
  '/:projectId/queues',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const body = createQueueSchema.parse(req.body);
    await assertProjectRole(req.userId, req.params.projectId, 'member');
    const queue = await createQueue(getPool(), { projectId: req.params.projectId, ...body });
    res.status(201).json(queue);
  }),
);

export const queuesRouter = Router();
queuesRouter.use(requireAuth);

/** Loads the queue and checks the caller's role on its project. */
async function loadQueueChecked(userId: string, queueId: string, minRole: 'viewer' | 'member' | 'admin') {
  const queue = await getQueueById(getPool(), queueId);
  if (!queue) throw ApiError.notFound('Queue');
  await assertProjectRole(userId, queue.project_id, minRole);
  return queue;
}

queuesRouter.get(
  '/:queueId',
  asyncHandler<AuthedRequest>(async (req, res) => {
    res.json(await loadQueueChecked(req.userId, req.params.queueId, 'viewer'));
  }),
);

queuesRouter.patch(
  '/:queueId',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const body = updateQueueSchema.parse(req.body);
    const queue = await loadQueueChecked(req.userId, req.params.queueId, 'member');
    const updated = await updateQueue(getPool(), queue.id, body);
    await publishEvent(getPool(), { kind: 'queue.updated', projectId: queue.project_id, queueId: queue.id });
    res.json(updated);
  }),
);

queuesRouter.post(
  '/:queueId/pause',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const queue = await loadQueueChecked(req.userId, req.params.queueId, 'member');
    const updated = await setQueuePaused(getPool(), queue.id, true);
    await publishEvent(getPool(), { kind: 'queue.updated', projectId: queue.project_id, queueId: queue.id, status: 'paused' });
    res.json(updated);
  }),
);

queuesRouter.post(
  '/:queueId/resume',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const queue = await loadQueueChecked(req.userId, req.params.queueId, 'member');
    const updated = await setQueuePaused(getPool(), queue.id, false);
    await publishEvent(getPool(), { kind: 'queue.updated', projectId: queue.project_id, queueId: queue.id, status: 'resumed' });
    res.json(updated);
  }),
);

queuesRouter.delete(
  '/:queueId',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const queue = await loadQueueChecked(req.userId, req.params.queueId, 'admin');
    await deleteQueue(getPool(), queue.id);
    res.status(204).end();
  }),
);
