import { Router } from 'express';
import {
  createScheduledJob,
  deleteScheduledJob,
  describeCron,
  getPool,
  getQueueById,
  getScheduledJob,
  listScheduledJobs,
  publishEvent,
  updateScheduledJob,
} from '@pulse/core';
import { assertProjectRole, requireAuth, type AuthedRequest } from '../auth.js';
import { ApiError, asyncHandler } from '../errors.js';
import { createScheduleSchema, updateScheduleSchema } from '../validate.js';

export const projectSchedulesRouter = Router();
projectSchedulesRouter.use(requireAuth);

projectSchedulesRouter.get(
  '/:projectId/schedules',
  asyncHandler<AuthedRequest>(async (req, res) => {
    await assertProjectRole(req.userId, req.params.projectId, 'viewer');
    const schedules = await listScheduledJobs(getPool(), req.params.projectId);
    res.json({ data: schedules.map((s) => ({ ...s, cron_description: describeCron(s.cron_expression) })) });
  }),
);

projectSchedulesRouter.post(
  '/:projectId/schedules',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const body = createScheduleSchema.parse(req.body);
    await assertProjectRole(req.userId, req.params.projectId, 'member');
    const queue = await getQueueById(getPool(), body.queueId);
    if (!queue || queue.project_id !== req.params.projectId) throw ApiError.notFound('Queue in this project');
    try {
      const schedule = await createScheduledJob(getPool(), {
        projectId: req.params.projectId,
        createdBy: req.userId,
        ...body,
      });
      res.status(201).json(schedule);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Invalid cron')) throw ApiError.badRequest(err.message);
      throw err;
    }
  }),
);

export const schedulesRouter = Router();
schedulesRouter.use(requireAuth);

schedulesRouter.patch(
  '/:scheduleId',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const body = updateScheduleSchema.parse(req.body);
    const schedule = await getScheduledJob(getPool(), req.params.scheduleId);
    if (!schedule) throw ApiError.notFound('Schedule');
    await assertProjectRole(req.userId, schedule.project_id, 'member');
    try {
      const updated = await updateScheduledJob(getPool(), schedule.id, body);
      await publishEvent(getPool(), { kind: 'schedule.updated', projectId: schedule.project_id });
      res.json(updated);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Invalid cron')) throw ApiError.badRequest(err.message);
      throw err;
    }
  }),
);

schedulesRouter.delete(
  '/:scheduleId',
  asyncHandler<AuthedRequest>(async (req, res) => {
    const schedule = await getScheduledJob(getPool(), req.params.scheduleId);
    if (!schedule) throw ApiError.notFound('Schedule');
    await assertProjectRole(req.userId, schedule.project_id, 'member');
    await deleteScheduledJob(getPool(), schedule.id);
    res.status(204).end();
  }),
);
