import { z } from 'zod';

/** Shared request schemas. Parsed with .parse() — ZodErrors become 400s. */

export const registerSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().min(1).max(100),
  password: z.string().min(8).max(128),
  organizationName: z.string().min(1).max(100).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const createOrgSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and dashes only'),
});

export const addMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member', 'viewer']),
});

export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
  description: z.string().max(2000).optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
});

const retryPolicyFields = z.object({
  name: z.string().min(1).max(100),
  strategy: z.enum(['fixed', 'linear', 'exponential']),
  maxAttempts: z.number().int().min(1).max(25),
  baseDelayMs: z.number().int().min(0).max(3_600_000),
  maxDelayMs: z.number().int().min(0).max(86_400_000),
  jitterFactor: z.number().min(0).max(1).optional(),
});
export const retryPolicyBody = retryPolicyFields.refine((p) => p.maxDelayMs >= p.baseDelayMs, {
  message: 'maxDelayMs must be >= baseDelayMs',
});
export const retryPolicyPatch = retryPolicyFields.partial();

export const createQueueSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/),
  description: z.string().max(2000).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  maxConcurrency: z.number().int().min(1).max(1000).optional(),
  retryPolicyId: z.string().uuid().nullable().optional(),
  rateLimitPerSecond: z.number().int().min(1).max(10_000).nullable().optional(),
});

export const updateQueueSchema = createQueueSchema.partial();

const payloadSchema = z.record(z.unknown()).refine(
  (p) => JSON.stringify(p).length <= 64_000,
  { message: 'payload must serialise to at most 64KB' },
);

export const createJobSchema = z.object({
  type: z.string().min(1).max(200),
  payload: payloadSchema.optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  delayMs: z.number().int().min(0).max(30 * 86_400_000).optional(),
  runAt: z.coerce.date().optional(),
  timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
  maxAttempts: z.number().int().min(1).max(25).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  dependsOn: z.array(z.string().uuid()).max(50).optional(),
}).refine((j) => !(j.delayMs !== undefined && j.runAt !== undefined), {
  message: 'Provide either delayMs or runAt, not both',
});

export const createBatchSchema = z.object({
  jobs: z.array(createJobSchema).min(1).max(500),
});

export const createScheduleSchema = z.object({
  queueId: z.string().uuid(),
  name: z.string().min(1).max(100),
  cronExpression: z.string().min(1).max(100),
  timezone: z.string().max(60).optional(),
  jobType: z.string().min(1).max(200),
  payload: payloadSchema.optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
  maxAttempts: z.number().int().min(1).max(25).optional(),
});

export const updateScheduleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  cronExpression: z.string().min(1).max(100).optional(),
  timezone: z.string().max(60).optional(),
  payload: payloadSchema.optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  status: z.enum(['active', 'paused']).optional(),
});

export const jobListQuery = z.object({
  queueId: z.string().uuid().optional(),
  status: z.string().optional(), // comma-separated list
  type: z.string().max(200).optional(),
  batchId: z.string().uuid().optional(),
  scheduledJobId: z.string().uuid().optional(),
  workerId: z.string().uuid().optional(),
  search: z.string().max(100).optional(),
  createdAfter: z.coerce.date().optional(),
  createdBefore: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export const throughputQuery = z.object({
  windowMinutes: z.coerce.number().int().min(5).max(1440).default(60),
  bucketSeconds: z.coerce.number().int().min(10).max(3600).default(60),
});

const JOB_STATUSES = ['scheduled', 'queued', 'claimed', 'running', 'completed', 'failed', 'dead_letter', 'cancelled'] as const;

export function parseStatusList(raw: string | undefined) {
  if (!raw) return undefined;
  const statuses = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = statuses.filter((s) => !JOB_STATUSES.includes(s as (typeof JOB_STATUSES)[number]));
  if (invalid.length) {
    throw new z.ZodError([
      { code: 'custom', path: ['status'], message: `Invalid status value(s): ${invalid.join(', ')}` },
    ]);
  }
  return statuses as unknown as import('@pulse/core').JobStatus[];
}
