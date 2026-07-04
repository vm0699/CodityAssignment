-- ============================================================================
-- Migration 001 — Pulse initial schema
--
-- Design notes (full rationale in docs/DESIGN-DECISIONS.md):
--  * All primary keys are UUIDs (gen_random_uuid) so ids can be generated
--    client-side, are safe to expose in URLs, and merge cleanly across shards.
--  * Append-only/high-volume tables (job_logs, worker_heartbeats) use BIGSERIAL
--    keys instead — cheaper to index and naturally ordered for range pruning.
--  * Every FK either CASCADEs (owned children) or SET NULLs (loose references
--    kept for audit) — documented inline per constraint.
--  * Hot-path indexes are PARTIAL: the claim scan only ever looks at
--    status='queued' rows, so the index stays tiny even with millions of
--    finished jobs in the table.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid on PG < 13 compat

-- ---------------------------------------------------------------------------
-- Enums: constrain state at the database level so no service can write an
-- illegal status, whatever bugs it has.
-- ---------------------------------------------------------------------------
CREATE TYPE org_role         AS ENUM ('owner', 'admin', 'member', 'viewer');
CREATE TYPE backoff_strategy AS ENUM ('fixed', 'linear', 'exponential');
CREATE TYPE job_status       AS ENUM ('scheduled', 'queued', 'claimed', 'running',
                                      'completed', 'failed', 'dead_letter', 'cancelled');
CREATE TYPE execution_status AS ENUM ('running', 'completed', 'failed', 'timed_out', 'interrupted');
CREATE TYPE worker_status    AS ENUM ('online', 'draining', 'offline', 'dead');
CREATE TYPE log_level        AS ENUM ('debug', 'info', 'warn', 'error');
CREATE TYPE schedule_status  AS ENUM ('active', 'paused');

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
-- Identity & tenancy
-- ===========================================================================

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Case-insensitive uniqueness without the citext extension.
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  -- SET NULL: deleting a user must not delete the org they happened to create.
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RBAC: role is scoped to the organization. Composite PK — a user has exactly
-- one role per org; no surrogate key needed for a pure join table.
CREATE TABLE organization_members (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       org_role NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
-- Reverse lookup: "which orgs does this user belong to" (login, project list).
CREATE INDEX organization_members_user_idx ON organization_members (user_id);

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);
CREATE INDEX projects_org_idx ON projects (org_id);
CREATE TRIGGER projects_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- Queue configuration
-- ===========================================================================

-- Reusable, named retry policies. Queues point at a policy; jobs may override
-- max_attempts individually. NULL policy on a queue = system default
-- (exponential, 3 attempts, 1s base, 60s cap) resolved in the domain layer.
CREATE TABLE retry_policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          text NOT NULL,
  strategy      backoff_strategy NOT NULL DEFAULT 'exponential',
  max_attempts  int  NOT NULL DEFAULT 3   CHECK (max_attempts BETWEEN 1 AND 25),
  base_delay_ms int  NOT NULL DEFAULT 1000 CHECK (base_delay_ms >= 0),
  max_delay_ms  int  NOT NULL DEFAULT 60000 CHECK (max_delay_ms >= base_delay_ms),
  -- 0 = deterministic; 0.2 = +/-20% randomisation to avoid thundering herds.
  jitter_factor real NOT NULL DEFAULT 0    CHECK (jitter_factor BETWEEN 0 AND 1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
CREATE TRIGGER retry_policies_updated_at BEFORE UPDATE ON retry_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE queues (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  -- Higher runs first. Queue priority outranks job priority (strict ordering
  -- across queues, then within a queue).
  priority        int  NOT NULL DEFAULT 0,
  -- Max jobs from this queue in claimed/running state across ALL workers.
  max_concurrency int  NOT NULL DEFAULT 10 CHECK (max_concurrency BETWEEN 1 AND 1000),
  is_paused       boolean NOT NULL DEFAULT false,
  -- SET NULL: deleting a policy falls back to system defaults, never breaks a queue.
  retry_policy_id uuid REFERENCES retry_policies(id) ON DELETE SET NULL,
  -- Optional dispatch rate limit (jobs started per second, token bucket). NULL = unlimited.
  rate_limit_per_second int CHECK (rate_limit_per_second IS NULL OR rate_limit_per_second > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
CREATE INDEX queues_project_idx ON queues (project_id);
CREATE TRIGGER queues_updated_at BEFORE UPDATE ON queues
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- Workers (declared before jobs: jobs.worker_id references workers)
-- ===========================================================================

CREATE TABLE workers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  hostname          text NOT NULL,
  pid               int  NOT NULL,
  status            worker_status NOT NULL DEFAULT 'online',
  concurrency       int NOT NULL DEFAULT 5,
  -- NULL = polls every queue; otherwise restricted to these queue ids.
  queue_filter      uuid[],
  started_at        timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  stopped_at        timestamptz
);
-- Liveness scan by the reaper: only live-ish workers are interesting.
CREATE INDEX workers_status_heartbeat_idx ON workers (status, last_heartbeat_at);

-- Heartbeat history (metrics/audit; current liveness lives on workers row).
-- BIGSERIAL: append-only, pruned by age, never joined by uuid.
CREATE TABLE worker_heartbeats (
  id           bigserial PRIMARY KEY,
  worker_id    uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  running_jobs int  NOT NULL DEFAULT 0,
  memory_mb    real,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX worker_heartbeats_worker_idx ON worker_heartbeats (worker_id, created_at DESC);
-- Pruning scan ("delete heartbeats older than 24h") without touching the pk.
CREATE INDEX worker_heartbeats_created_idx ON worker_heartbeats (created_at);

-- ===========================================================================
-- Recurring schedules (cron definitions) — declared before jobs so job rows
-- can link back to the schedule that spawned them.
-- ===========================================================================

CREATE TABLE scheduled_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  queue_id         uuid NOT NULL REFERENCES queues(id)   ON DELETE CASCADE,
  name             text NOT NULL,
  cron_expression  text NOT NULL,
  timezone         text NOT NULL DEFAULT 'UTC',
  job_type         text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}',
  priority         int NOT NULL DEFAULT 0,
  timeout_ms       int NOT NULL DEFAULT 60000 CHECK (timeout_ms BETWEEN 100 AND 3600000),
  max_attempts     int CHECK (max_attempts IS NULL OR max_attempts BETWEEN 1 AND 25),
  status           schedule_status NOT NULL DEFAULT 'active',
  next_run_at      timestamptz NOT NULL,
  last_enqueued_at timestamptz,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
-- The scheduler's due-scan: "active schedules whose next_run_at has passed".
CREATE INDEX scheduled_jobs_due_idx ON scheduled_jobs (next_run_at) WHERE status = 'active';
CREATE INDEX scheduled_jobs_queue_idx ON scheduled_jobs (queue_id);
CREATE TRIGGER scheduled_jobs_updated_at BEFORE UPDATE ON scheduled_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- Jobs — the hot table
-- ===========================================================================

CREATE TABLE jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id         uuid NOT NULL REFERENCES queues(id)   ON DELETE CASCADE,
  -- Denormalised copy of the queue's project: the job explorer filters by
  -- project on every request and must not join through queues to do it.
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scheduled_job_id uuid REFERENCES scheduled_jobs(id) ON DELETE SET NULL,
  -- Groups the members of one batch submission.
  batch_id         uuid,
  type             text  NOT NULL,          -- handler key, e.g. 'http.request'
  payload          jsonb NOT NULL DEFAULT '{}',
  status           job_status NOT NULL DEFAULT 'queued',
  priority         int   NOT NULL DEFAULT 0,
  attempt          int   NOT NULL DEFAULT 0,   -- attempts started so far
  max_attempts     int CHECK (max_attempts IS NULL OR max_attempts BETWEEN 1 AND 25),
  -- When the job becomes eligible to run (delay / schedule / retry backoff).
  run_at           timestamptz NOT NULL DEFAULT now(),
  timeout_ms       int NOT NULL DEFAULT 60000 CHECK (timeout_ms BETWEEN 100 AND 3600000),
  -- Client-supplied dedupe key: two submissions with the same key on the same
  -- queue collapse into one job (enforced by partial unique index below).
  idempotency_key  text,
  -- Number of parent jobs that have not completed yet. > 0 keeps the job in
  -- 'scheduled' regardless of run_at; decremented transactionally as parents
  -- finish, so release is race-free without re-counting the join table.
  pending_dependencies int NOT NULL DEFAULT 0 CHECK (pending_dependencies >= 0),
  worker_id        uuid REFERENCES workers(id) ON DELETE SET NULL,
  output           jsonb,
  last_error       text,
  failure_summary  text,                      -- AI/rule-generated triage note
  claimed_at       timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- THE claim index: covers the worker claim scan exactly (filter by queue +
-- order by priority, run_at). Partial on 'queued' so completed history never
-- bloats it.
CREATE INDEX jobs_claim_idx ON jobs (queue_id, priority DESC, run_at ASC)
  WHERE status = 'queued';
-- Scheduler due-scan for delayed/scheduled/retry-waiting jobs.
CREATE INDEX jobs_due_idx ON jobs (run_at) WHERE status = 'scheduled';
-- Job explorer: newest-first listing per project with status filter.
CREATE INDEX jobs_project_status_idx ON jobs (project_id, status, created_at DESC);
CREATE INDEX jobs_queue_status_idx   ON jobs (queue_id, status);
-- Reaper: find jobs held by a dead worker. Partial: only in-flight jobs matter.
CREATE INDEX jobs_inflight_worker_idx ON jobs (worker_id)
  WHERE status IN ('claimed', 'running');
CREATE INDEX jobs_batch_idx ON jobs (batch_id) WHERE batch_id IS NOT NULL;
CREATE UNIQUE INDEX jobs_idempotency_idx ON jobs (queue_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per attempt: retry history with timings, worker attribution, errors.
CREATE TABLE job_executions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt     int  NOT NULL,
  worker_id   uuid REFERENCES workers(id) ON DELETE SET NULL,
  status      execution_status NOT NULL DEFAULT 'running',
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms int,
  error       text,
  output      jsonb,
  UNIQUE (job_id, attempt)                    -- an attempt executes once
);
CREATE INDEX job_executions_job_idx ON job_executions (job_id, attempt DESC);
-- Worker drill-down + recent activity feeds.
CREATE INDEX job_executions_worker_idx ON job_executions (worker_id, started_at DESC);
-- Throughput metrics: executions finished per time bucket.
CREATE INDEX job_executions_finished_idx ON job_executions (finished_at)
  WHERE finished_at IS NOT NULL;

-- Structured, append-only log lines emitted during execution.
CREATE TABLE job_logs (
  id           bigserial PRIMARY KEY,
  job_id       uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  execution_id uuid REFERENCES job_executions(id) ON DELETE CASCADE,
  worker_id    uuid,
  level        log_level NOT NULL DEFAULT 'info',
  message      text NOT NULL,
  context      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- Serial pk is insertion-ordered, so (job_id, id) reads a job's log in order
-- with no timestamp tie-breaking.
CREATE INDEX job_logs_job_idx ON job_logs (job_id, id);

-- Audit record for permanently failed jobs. The job row keeps status
-- 'dead_letter'; this table snapshots why, and tracks requeue actions.
CREATE TABLE dead_letter_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           uuid NOT NULL REFERENCES jobs(id)    ON DELETE CASCADE,
  queue_id         uuid NOT NULL REFERENCES queues(id)  ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reason           text NOT NULL,
  error            text,
  failure_summary  text,
  attempts_made    int  NOT NULL,
  payload_snapshot jsonb NOT NULL,
  moved_at         timestamptz NOT NULL DEFAULT now(),
  requeued_at      timestamptz,
  requeued_by      uuid REFERENCES users(id) ON DELETE SET NULL
);
-- A job can enter the DLQ multiple times (requeue → fail again). "Active"
-- entry = requeued_at IS NULL; at most one active entry per job.
CREATE UNIQUE INDEX dead_letter_active_job_idx ON dead_letter_jobs (job_id)
  WHERE requeued_at IS NULL;
CREATE INDEX dead_letter_project_idx ON dead_letter_jobs (project_id, moved_at DESC);
CREATE INDEX dead_letter_queue_idx   ON dead_letter_jobs (queue_id, moved_at DESC);

-- Workflow DAG edges: job_id runs only after depends_on_job_id completes.
CREATE TABLE job_dependencies (
  job_id            uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  depends_on_job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, depends_on_job_id),
  CHECK (job_id <> depends_on_job_id)
);
-- "Which children does this finished parent unblock" — the resolver's scan.
CREATE INDEX job_dependencies_parent_idx ON job_dependencies (depends_on_job_id);
