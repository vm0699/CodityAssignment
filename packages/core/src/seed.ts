/**
 * Seeds a demo workspace so the dashboard is alive on first boot:
 *   user demo@pulse.dev / demo1234, org, project, retry policies, queues,
 *   a recurring cron schedule, and a spread of jobs (immediate, delayed,
 *   batch, flaky-with-retries, and a 3-step workflow with dependencies).
 * Idempotent: re-running skips everything if the demo user already exists.
 */
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { closePool, getPool, withTransaction } from './db.js';
import { env, loadEnv } from './env.js';
import { runMigrations } from './migrate.js';
import { createJob } from './repos/jobs.js';
import { createOrganization } from './repos/orgs.js';
import { createProject } from './repos/projects.js';
import { createQueue } from './repos/queues.js';
import { createRetryPolicy } from './repos/retry-policies.js';
import { createScheduledJob } from './repos/scheduled-jobs.js';
import { createUser, findUserByEmail } from './repos/users.js';

loadEnv();
await runMigrations(env('DATABASE_URL'));

const pool = getPool();
const existing = await findUserByEmail(pool, 'demo@pulse.dev');
if (existing) {
  console.log('Demo data already seeded — nothing to do.');
  await closePool();
  process.exit(0);
}

const user = await createUser(pool, {
  email: 'demo@pulse.dev',
  name: 'Demo User',
  passwordHash: await bcrypt.hash('demo1234', 10),
});
const org = await createOrganization(pool, { name: 'Acme Corp', slug: 'acme', createdBy: user.id });
const project = await createProject(pool, {
  orgId: org.id,
  name: 'Payments Platform',
  slug: 'payments',
  description: 'Background processing for the payments product',
  createdBy: user.id,
});

const aggressive = await createRetryPolicy(pool, {
  projectId: project.id, name: 'aggressive-exponential',
  strategy: 'exponential', maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 30_000, jitterFactor: 0.2,
});
const gentle = await createRetryPolicy(pool, {
  projectId: project.id, name: 'gentle-fixed',
  strategy: 'fixed', maxAttempts: 3, baseDelayMs: 5000, maxDelayMs: 5000,
});

const critical = await createQueue(pool, {
  projectId: project.id, name: 'critical', description: 'Payment captures and refunds',
  priority: 100, maxConcurrency: 10, retryPolicyId: aggressive.id,
});
const dflt = await createQueue(pool, {
  projectId: project.id, name: 'default', description: 'General background work',
  priority: 10, maxConcurrency: 8, retryPolicyId: aggressive.id,
});
const emails = await createQueue(pool, {
  projectId: project.id, name: 'emails', description: 'Transactional email delivery',
  priority: 20, maxConcurrency: 4, retryPolicyId: gentle.id, rateLimitPerSecond: 10,
});
const reports = await createQueue(pool, {
  projectId: project.id, name: 'reports', description: 'Scheduled report generation',
  priority: 5, maxConcurrency: 2, retryPolicyId: gentle.id,
});

await createScheduledJob(pool, {
  projectId: project.id, queueId: reports.id, name: 'hourly-settlement-report',
  cronExpression: '0 * * * *', jobType: 'demo.compute',
  payload: { report: 'settlement', iterations: 30 }, createdBy: user.id,
});
await createScheduledJob(pool, {
  projectId: project.id, queueId: dflt.id, name: 'minutely-health-probe',
  cronExpression: '* * * * *', jobType: 'http.request',
  payload: { url: 'https://example.com', method: 'GET' }, createdBy: user.id,
});

await withTransaction(async (client) => {
  // Immediate jobs across queues
  for (let i = 0; i < 6; i++) {
    await createJob(client, {
      queueId: dflt.id, projectId: project.id, type: 'demo.compute',
      payload: { iterations: 10 + i * 5 }, createdBy: user.id,
    });
  }
  for (let i = 0; i < 4; i++) {
    await createJob(client, {
      queueId: emails.id, projectId: project.id, type: 'email.send',
      payload: { to: `customer${i}@example.com`, template: 'receipt' }, createdBy: user.id,
    });
  }
  // A flaky job that will exercise retries (60% failure rate per attempt)
  await createJob(client, {
    queueId: critical.id, projectId: project.id, type: 'demo.flaky',
    payload: { failureRate: 0.6 }, createdBy: user.id,
  });
  // A job guaranteed to exhaust retries → lands in the DLQ for the demo
  await createJob(client, {
    queueId: critical.id, projectId: project.id, type: 'demo.flaky',
    payload: { failureRate: 1 }, maxAttempts: 2, createdBy: user.id,
  });
  // Delayed job
  await createJob(client, {
    queueId: dflt.id, projectId: project.id, type: 'demo.sleep',
    payload: { ms: 2000 }, delayMs: 60_000, createdBy: user.id,
  });
  // Batch of 5
  const batchId = randomUUID();
  for (let i = 0; i < 5; i++) {
    await createJob(client, {
      queueId: reports.id, projectId: project.id, type: 'demo.compute',
      payload: { chunk: i, iterations: 20 }, batchId, createdBy: user.id,
    });
  }
  // Workflow: extract → transform → load
  const { job: extract } = await createJob(client, {
    queueId: dflt.id, projectId: project.id, type: 'demo.compute',
    payload: { step: 'extract', iterations: 15 }, createdBy: user.id,
  });
  const { job: transform } = await createJob(client, {
    queueId: dflt.id, projectId: project.id, type: 'demo.compute',
    payload: { step: 'transform', iterations: 15 }, dependsOn: [extract.id], createdBy: user.id,
  });
  await createJob(client, {
    queueId: dflt.id, projectId: project.id, type: 'demo.compute',
    payload: { step: 'load', iterations: 15 }, dependsOn: [transform.id], createdBy: user.id,
  });
});

console.log('Seeded demo workspace:');
console.log('  login: demo@pulse.dev / demo1234');
console.log(`  project: ${project.name} (${project.id})`);
await closePool();
