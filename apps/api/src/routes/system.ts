import { Router } from 'express';
import { getPool, listSystemEvents } from '@pulse/core';
import { requireAuth } from '../auth.js';
import { asyncHandler } from '../errors.js';

/**
 * Platform-wide operational activity feed (worker claims, reaper recoveries,
 * leader election, cron fires, DLQ moves — see packages/core/src/repos/system-events.ts).
 * Deliberately not project-scoped: it describes cluster infrastructure, not
 * tenant data, so any authenticated user can view it. This is what backs the
 * dashboard's "Activity Log" page.
 */
export const systemRouter = Router();
systemRouter.use(requireAuth);

systemRouter.get(
  '/events',
  asyncHandler(async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number.parseInt(String(req.query.limit ?? '200'), 10) || 200));
    const component = typeof req.query.component === 'string' ? req.query.component : undefined;
    const events = await listSystemEvents(getPool(), { limit, component });
    res.json({ data: events });
  }),
);
