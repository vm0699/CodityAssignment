export type JobStatus =
  | 'scheduled' | 'queued' | 'claimed' | 'running'
  | 'completed' | 'failed' | 'dead_letter' | 'cancelled';

export interface User { id: string; email: string; name: string }
export interface Org { id: string; name: string; slug: string; role: string }
export interface Project {
  id: string; org_id: string; name: string; slug: string; description: string; org_name?: string;
}
export interface RetryPolicy {
  id: string; project_id: string; name: string; strategy: 'fixed' | 'linear' | 'exponential';
  max_attempts: number; base_delay_ms: number; max_delay_ms: number; jitter_factor: number;
}
export interface Queue {
  id: string; project_id: string; name: string; description: string;
  priority: number; max_concurrency: number; is_paused: boolean;
  retry_policy_id: string | null; rate_limit_per_second: number | null;
}
export interface QueueStats {
  queue_id: string; scheduled: number; queued: number; claimed: number; running: number;
  completed: number; failed: number; dead_letter: number; cancelled: number;
  success_rate_24h: number | null; avg_duration_ms_24h: number | null;
}
export interface Job {
  id: string; queue_id: string; project_id: string; queue_name?: string;
  scheduled_job_id: string | null; batch_id: string | null;
  type: string; payload: Record<string, unknown>; status: JobStatus;
  priority: number; attempt: number; max_attempts: number | null;
  run_at: string; timeout_ms: number; idempotency_key: string | null;
  pending_dependencies: number; worker_id: string | null;
  output: Record<string, unknown> | null; last_error: string | null; failure_summary: string | null;
  claimed_at: string | null; started_at: string | null; finished_at: string | null;
  created_at: string;
}
export interface JobExecution {
  id: string; job_id: string; attempt: number; worker_id: string | null;
  status: string; started_at: string; finished_at: string | null;
  duration_ms: number | null; error: string | null; output: Record<string, unknown> | null;
}
export interface JobDetail extends Job {
  executions: JobExecution[];
  dependencies: {
    dependsOn: Array<{ id: string; status: JobStatus; type: string }>;
    dependents: Array<{ id: string; status: JobStatus; type: string }>;
  };
}
export interface JobLog {
  id: number; job_id: string; level: string; message: string;
  context: Record<string, unknown> | null; created_at: string;
}
export interface WorkerView {
  id: string; name: string; hostname: string; pid: number;
  status: 'online' | 'draining' | 'offline' | 'dead';
  concurrency: number; running_jobs: number; seconds_since_heartbeat: number;
  started_at: string; last_heartbeat_at: string;
}
export interface DlqEntry {
  id: string; job_id: string; queue_id: string; project_id: string;
  reason: string; error: string | null; failure_summary: string | null;
  attempts_made: number; payload_snapshot: Record<string, unknown>;
  moved_at: string; requeued_at: string | null; job_type: string; queue_name: string;
}
export interface Schedule {
  id: string; project_id: string; queue_id: string; name: string;
  cron_expression: string; cron_description?: string; timezone: string;
  job_type: string; payload: Record<string, unknown>; priority: number;
  status: 'active' | 'paused'; next_run_at: string; last_enqueued_at: string | null;
}
export interface SystemEvent {
  id: number; level: 'debug' | 'info' | 'warn' | 'error'; component: string;
  message: string; context: Record<string, unknown> | null; created_at: string;
}
export interface Overview {
  status_counts: Record<string, number>;
  jobs_last_hour: number; completed_last_hour: number; failed_attempts_last_hour: number;
  dead_letter_active: number; workers_online: number;
  avg_duration_ms_1h: number | null; p95_duration_ms_1h: number | null;
  oldest_queued_age_seconds: number | null;
}
export interface ThroughputPoint { bucket: string; completed: number; failed: number; created: number }
export interface Paginated<T> { data: T[]; pagination: { total: number; limit: number; offset: number } }
