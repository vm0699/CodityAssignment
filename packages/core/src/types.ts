export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';
export type BackoffStrategy = 'fixed' | 'linear' | 'exponential';
export type JobStatus =
  | 'scheduled'
  | 'queued'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'dead_letter'
  | 'cancelled';
export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'timed_out' | 'interrupted';
export type WorkerStatus = 'online' | 'draining' | 'offline' | 'dead';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type ScheduleStatus = 'active' | 'paused';

export interface User {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface OrganizationMember {
  org_id: string;
  user_id: string;
  role: OrgRole;
  created_at: Date;
}

export interface Project {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  description: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RetryPolicy {
  id: string;
  project_id: string;
  name: string;
  strategy: BackoffStrategy;
  max_attempts: number;
  base_delay_ms: number;
  max_delay_ms: number;
  jitter_factor: number;
  created_at: Date;
  updated_at: Date;
}

/** System fallback when a queue has no policy attached. */
export const DEFAULT_RETRY_POLICY: Pick<
  RetryPolicy,
  'strategy' | 'max_attempts' | 'base_delay_ms' | 'max_delay_ms' | 'jitter_factor'
> = {
  strategy: 'exponential',
  max_attempts: 3,
  base_delay_ms: 1000,
  max_delay_ms: 60_000,
  jitter_factor: 0,
};

export interface Queue {
  id: string;
  project_id: string;
  name: string;
  description: string;
  priority: number;
  max_concurrency: number;
  is_paused: boolean;
  retry_policy_id: string | null;
  rate_limit_per_second: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface Job {
  id: string;
  queue_id: string;
  project_id: string;
  scheduled_job_id: string | null;
  batch_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  attempt: number;
  max_attempts: number | null;
  run_at: Date;
  timeout_ms: number;
  idempotency_key: string | null;
  pending_dependencies: number;
  worker_id: string | null;
  output: Record<string, unknown> | null;
  last_error: string | null;
  failure_summary: string | null;
  claimed_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface JobExecution {
  id: string;
  job_id: string;
  attempt: number;
  worker_id: string | null;
  status: ExecutionStatus;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: number | null;
  error: string | null;
  output: Record<string, unknown> | null;
}

export interface JobLog {
  id: number;
  job_id: string;
  execution_id: string | null;
  worker_id: string | null;
  level: LogLevel;
  message: string;
  context: Record<string, unknown> | null;
  created_at: Date;
}

export interface ScheduledJob {
  id: string;
  project_id: string;
  queue_id: string;
  name: string;
  cron_expression: string;
  timezone: string;
  job_type: string;
  payload: Record<string, unknown>;
  priority: number;
  timeout_ms: number;
  max_attempts: number | null;
  status: ScheduleStatus;
  next_run_at: Date;
  last_enqueued_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface WorkerRow {
  id: string;
  name: string;
  hostname: string;
  pid: number;
  status: WorkerStatus;
  concurrency: number;
  queue_filter: string[] | null;
  started_at: Date;
  last_heartbeat_at: Date;
  stopped_at: Date | null;
}

export interface DeadLetterJob {
  id: string;
  job_id: string;
  queue_id: string;
  project_id: string;
  reason: string;
  error: string | null;
  failure_summary: string | null;
  attempts_made: number;
  payload_snapshot: Record<string, unknown>;
  moved_at: Date;
  requeued_at: Date | null;
  requeued_by: string | null;
}

/** Event published on the pg NOTIFY bus and fanned out over WebSockets. */
export interface PulseEvent {
  kind:
    | 'job.updated'
    | 'job.created'
    | 'queue.updated'
    | 'worker.updated'
    | 'dlq.updated'
    | 'schedule.updated'
    | 'system.log';
  projectId?: string;
  jobId?: string;
  queueId?: string;
  workerId?: string;
  status?: string;
  at: string;
  // 'system.log' payload — carried inline so the dashboard's Activity feed
  // can render it without a follow-up fetch.
  id?: number;
  level?: LogLevel;
  component?: string;
  message?: string;
}
