# Database design

Full schema source: [packages/core/migrations/001_initial_schema.sql](../packages/core/migrations/001_initial_schema.sql)
(heavily commented — this document summarises the reasoning).

## Entity-relationship diagram

```mermaid
erDiagram
    USERS ||--o{ ORGANIZATION_MEMBERS : "has"
    ORGANIZATIONS ||--o{ ORGANIZATION_MEMBERS : "has"
    ORGANIZATIONS ||--o{ PROJECTS : "owns"
    PROJECTS ||--o{ QUEUES : "owns"
    PROJECTS ||--o{ RETRY_POLICIES : "defines"
    PROJECTS ||--o{ SCHEDULED_JOBS : "defines"
    RETRY_POLICIES |o--o{ QUEUES : "configures"
    QUEUES ||--o{ JOBS : "contains"
    QUEUES ||--o{ SCHEDULED_JOBS : "targets"
    SCHEDULED_JOBS |o--o{ JOBS : "spawns"
    JOBS ||--o{ JOB_EXECUTIONS : "attempts"
    JOBS ||--o{ JOB_LOGS : "logs"
    JOBS ||--o{ DEAD_LETTER_JOBS : "audit trail"
    JOBS ||--o{ JOB_DEPENDENCIES : "depends on"
    WORKERS ||--o{ JOBS : "claims"
    WORKERS ||--o{ WORKER_HEARTBEATS : "reports"
    WORKERS ||--o{ JOB_EXECUTIONS : "runs"

    USERS {
        uuid id PK
        text email UK "unique, case-insensitive"
        text name
        text password_hash
    }
    ORGANIZATIONS {
        uuid id PK
        text name
        text slug UK
        uuid created_by FK "SET NULL"
    }
    ORGANIZATION_MEMBERS {
        uuid org_id PK_FK
        uuid user_id PK_FK
        org_role role "owner/admin/member/viewer"
    }
    PROJECTS {
        uuid id PK
        uuid org_id FK "CASCADE"
        text name
        text slug "UNIQUE per org"
    }
    RETRY_POLICIES {
        uuid id PK
        uuid project_id FK "CASCADE"
        text name
        backoff_strategy strategy "fixed/linear/exponential"
        int max_attempts
        int base_delay_ms
        int max_delay_ms
        real jitter_factor
    }
    QUEUES {
        uuid id PK
        uuid project_id FK "CASCADE"
        text name "UNIQUE per project"
        int priority
        int max_concurrency
        boolean is_paused
        uuid retry_policy_id FK "SET NULL"
        int rate_limit_per_second
    }
    SCHEDULED_JOBS {
        uuid id PK
        uuid project_id FK "CASCADE"
        uuid queue_id FK "CASCADE"
        text cron_expression
        text timezone
        timestamptz next_run_at
        schedule_status status
    }
    JOBS {
        uuid id PK
        uuid queue_id FK "CASCADE"
        uuid project_id FK "CASCADE, denormalised"
        uuid scheduled_job_id FK "SET NULL"
        uuid batch_id "grouping, nullable"
        text type "handler key"
        jsonb payload
        job_status status
        int priority
        int attempt
        timestamptz run_at
        text idempotency_key "UNIQUE per queue"
        int pending_dependencies
        uuid worker_id FK "SET NULL"
    }
    JOB_EXECUTIONS {
        uuid id PK
        uuid job_id FK "CASCADE"
        int attempt "UNIQUE with job_id"
        uuid worker_id FK "SET NULL"
        execution_status status
        int duration_ms
    }
    JOB_LOGS {
        bigserial id PK
        uuid job_id FK "CASCADE"
        uuid execution_id FK "CASCADE"
        log_level level
        text message
    }
    DEAD_LETTER_JOBS {
        uuid id PK
        uuid job_id FK "CASCADE"
        text reason
        int attempts_made
        jsonb payload_snapshot
        timestamptz requeued_at "NULL = active entry"
    }
    JOB_DEPENDENCIES {
        uuid job_id PK_FK "CASCADE"
        uuid depends_on_job_id PK_FK "CASCADE"
    }
    WORKERS {
        uuid id PK
        text name
        worker_status status
        int concurrency
        timestamptz last_heartbeat_at
    }
    WORKER_HEARTBEATS {
        bigserial id PK
        uuid worker_id FK "CASCADE"
        int running_jobs
        real memory_mb
    }
```

## Key design decisions

**UUID primary keys everywhere except two append-only tables.** `job_logs`
and `worker_heartbeats` use `BIGSERIAL` instead: they are high-volume,
insertion-ordered, never referenced by other tables' foreign keys, and never
exposed as an external identifier a client generates ahead of time. A serial
key is cheaper to index and its ordering *is* the timeline, which the log
viewer relies on directly (`ORDER BY (job_id, id)` instead of a timestamp
tie-break).

**Cascading behavior is chosen per relationship, not by default:**
- **CASCADE** everywhere a child is *owned* by its parent and has no meaning
  without it (organization → project → queue → job → job_executions/job_logs).
  Deleting a project should not leave orphaned queues.
- **SET NULL** everywhere the reference is informational/audit rather than
  ownership: `created_by` on every table (deleting a user account must not
  delete their organization or job history), `queue.retry_policy_id` (deleting
  a policy falls back to the system default rather than breaking the queue),
  `job.worker_id` (a worker can be deregistered without deleting job history).

**Normalization vs. one deliberate denormalization.** The schema is in 3NF
throughout, with a single intentional exception: `jobs.project_id` duplicates
what's derivable by joining through `queue_id → queues.project_id`. The job
explorer's primary query pattern is "jobs in this project, filtered by status,
paginated, newest first" — without the denormalised column that query needs a
join against `queues` just to filter, defeating the point of the
`(project_id, status, created_at DESC)` index. The column is written once at
insert time and never updated, so it carries no update-anomaly risk.

**Indexes are shaped around the four hottest queries, not "index every
foreign key":**

| Index | Query it serves | Why partial/composite |
|---|---|---|
| `jobs_claim_idx (queue_id, priority DESC, run_at ASC) WHERE status='queued'` | the worker's claim scan | partial: stays tiny forever even with millions of completed jobs in the table — completed/failed rows never enter this index |
| `jobs_due_idx (run_at) WHERE status='scheduled'` | scheduler's due-scan | partial, same reasoning |
| `jobs_project_status_idx (project_id, status, created_at DESC)` | job explorer list+filter+sort | composite matches the exact `WHERE ... ORDER BY` shape, no extra sort step |
| `jobs_inflight_worker_idx (worker_id) WHERE status IN ('claimed','running')` | reaper's "find this dead worker's jobs" | partial: terminal-state jobs (the vast majority over time) never enter it |
| `dead_letter_active_job_idx (job_id) WHERE requeued_at IS NULL` | "is there an active DLQ entry for this job" + enforces at most one | unique + partial encodes a business rule directly as a constraint |
| `scheduled_jobs_due_idx (next_run_at) WHERE status='active'` | cron due-scan | partial: paused schedules never pollute the scan |

**Enums instead of free-text status columns.** `job_status`,
`execution_status`, `worker_status`, `org_role`, `backoff_strategy` are all
Postgres `ENUM` types. A typo'd status string is a compile error at the
database level, not a silent bug discovered in production — this matters
more here than in most schemas because so much of the system's correctness
(the claim query, the state machine, the reaper) depends on status values
being exactly right.

**Concurrency-relevant constraints:**
- `dead_letter_active_job_idx` is a **partial unique index**, not a table-level
  invariant — it says "at most one *active* (non-requeued) DLQ entry per job"
  while still allowing history (a job can be dead-lettered, requeued, and
  dead-lettered again).
- `jobs_idempotency_idx (queue_id, idempotency_key) WHERE idempotency_key IS
  NOT NULL` turns client-side deduplication into a database-enforced
  guarantee — the `ON CONFLICT ... DO NOTHING` in `createJob` relies on this
  exact index existing.
- `job_dependencies` has no separate surrogate key; `(job_id,
  depends_on_job_id)` is already a natural composite primary key for a pure
  edge table, and `CHECK (job_id <> depends_on_job_id)` rules out a
  self-dependency at the schema level rather than in application code.
