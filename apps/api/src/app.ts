import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { createLogger, getPool } from '@pulse/core';
import { errorHandler, notFoundHandler } from './errors.js';
import { rateLimiter } from './rate-limit.js';
import { authRouter } from './routes/auth.js';
import { jobsRouter, projectJobsRouter, queueJobsRouter } from './routes/jobs.js';
import { orgsRouter } from './routes/orgs.js';
import { dlqRouter, metricsRouter, projectDlqRouter, workersRouter } from './routes/ops.js';
import { projectsRouter, retryPoliciesRouter } from './routes/projects.js';
import { projectQueuesRouter, queuesRouter } from './routes/queues.js';
import { projectSchedulesRouter, schedulesRouter } from './routes/schedules.js';
import { systemRouter } from './routes/system.js';

const log = createLogger({ component: 'api' });

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true }));
  app.use(express.json({ limit: '1mb' }));

  // Request id + structured access log.
  app.use((req, res, next) => {
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    const start = Date.now();
    res.on('finish', () => {
      log.info(`${req.method} ${req.path} ${res.statusCode}`, {
        requestId,
        durationMs: Date.now() - start,
      });
    });
    next();
  });

  app.use(rateLimiter());

  app.get('/api/health', async (_req, res) => {
    try {
      await getPool().query('SELECT 1');
      res.json({ status: 'ok', database: 'up', time: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'down' });
    }
  });

  app.use('/api/auth', authRouter);
  app.use('/api/orgs', orgsRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/projects', projectQueuesRouter);   // /:projectId/queues
  app.use('/api/projects', projectJobsRouter);     // /:projectId/jobs
  app.use('/api/projects', projectSchedulesRouter);// /:projectId/schedules
  app.use('/api/projects', projectDlqRouter);      // /:projectId/dlq
  app.use('/api/projects', metricsRouter);         // /:projectId/metrics/*
  app.use('/api/retry-policies', retryPoliciesRouter);
  app.use('/api/queues', queuesRouter);
  app.use('/api/queues', queueJobsRouter);         // /:queueId/jobs
  app.use('/api/jobs', jobsRouter);
  app.use('/api/schedules', schedulesRouter);
  app.use('/api/workers', workersRouter);
  app.use('/api/dlq', dlqRouter);
  app.use('/api/system', systemRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
