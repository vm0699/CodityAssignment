# Architecture

## Component diagram

```mermaid
flowchart TB
    subgraph Clients
        Browser["Dashboard (React)"]
    end

    subgraph AppTier["Application tier (stateless, horizontally scalable)"]
        API["API service\nExpress REST + WebSocket gateway\nauth · RBAC · validation · rate limiting"]
        Worker1["Worker #1\npoll → claim → execute → heartbeat"]
        Worker2["Worker #2..N\n(scale by running more)"]
        Scheduler1["Scheduler (leader)\npromotes due jobs\nmaterialises cron"]
        Scheduler2["Scheduler (standby)\nadvisory-lock leader election"]
    end

    subgraph Data["Data tier"]
        PG[("PostgreSQL 16\ntables · SKIP LOCKED claim\nadvisory locks · LISTEN/NOTIFY")]
    end

    Browser -- "HTTPS REST" --> API
    Browser <-- "WebSocket /ws\n(live job/queue/worker events)" --> API
    API -- "SQL" --> PG
    API -. "LISTEN pulse_events" .-> PG

    Worker1 -- "SQL: claim (SKIP LOCKED),\nexecute, heartbeat" --> PG
    Worker2 -- "SQL" --> PG
    Worker1 -. "LISTEN pulse_wake" .-> PG
    Worker2 -. "LISTEN pulse_wake" .-> PG

    Scheduler1 -- "SQL: promote due jobs,\nmaterialise cron" --> PG
    Scheduler2 -. "pg_try_advisory_lock\n(hot standby)" .-> PG

    PG -- "NOTIFY pulse_events" --> API
    PG -- "NOTIFY pulse_wake" --> Worker1
    PG -- "NOTIFY pulse_wake" --> Worker2

    External[["External systems\n(HTTP APIs called by job handlers)"]]
    Worker1 -.-> External
    Worker2 -.-> External
```

## Why three separate services instead of one monolith

| Service | Responsibility | Scaling axis |
|---|---|---|
| **API** | Auth, CRUD, validation, RBAC, read models, WebSocket fan-out | scale with request traffic |
| **Worker** | Claim + execute jobs, heartbeat, crash recovery (reaper) | scale with job throughput / CPU |
| **Scheduler** | Promote due jobs, materialise cron schedules | never needs more than one *active* instance |

Splitting them means a burst of job execution (CPU-heavy `demo.compute`,
slow `http.request` calls) never starves API request latency, and the
scheduler — which must not double-fire a cron schedule — can run as a
singleton without limiting how many workers or API replicas exist. All three
communicate exclusively through PostgreSQL: no message broker, no shared
memory, no service-to-service RPC. This keeps the system's correctness
guarantees anchored to the database's transactional guarantees instead of a
second consistency model.

## Postgres as the coordination substrate

Three Postgres primitives do the work usually spread across Postgres + Redis
+ RabbitMQ/Kafka + ZooKeeper:

1. **`SELECT ... FOR UPDATE SKIP LOCKED`** — atomic job claiming. Two workers
   racing for the same row: one gets it, the other's `SKIP LOCKED` silently
   passes over it and claims something else. No duplicate execution, no
   external lock service.
2. **Advisory locks (`pg_advisory_lock` / `pg_try_advisory_xact_lock`)** —
   scheduler leader election (session-level lock, released automatically if
   the leader's connection dies) and claim-transaction serialization
   (transaction-level lock, see [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md)).
3. **`LISTEN` / `NOTIFY`** — event-driven wake-ups. Workers poll on a slow
   fallback interval but usually wake up within milliseconds of a job
   becoming runnable; the API's WebSocket gateway subscribes once and fans
   out to every connected browser.

## Request/data flow: creating and running a job

```mermaid
sequenceDiagram
    participant U as Dashboard
    participant A as API
    participant DB as Postgres
    participant W as Worker
    participant S as Scheduler

    U->>A: POST /queues/:id/jobs {type, payload, delayMs?}
    A->>DB: INSERT job (status=queued|scheduled)
    A->>DB: NOTIFY pulse_wake, pulse_events
    DB-->>W: (LISTEN pulse_wake)
    DB-->>A: (LISTEN pulse_events) -> WebSocket -> U

    alt delayed/scheduled
        S->>DB: UPDATE scheduled -> queued (run_at due)
        DB-->>W: NOTIFY pulse_wake
    end

    W->>DB: claim (SKIP LOCKED, priority-ordered)
    W->>DB: mark running, start execution record
    W->>W: run handler(payload)
    alt success
        W->>DB: mark completed, release dependents
    else failure
        W->>DB: mark failed -> compute backoff -> scheduled (retry)
        Note over W,DB: attempts exhausted -> dead_letter + DLQ row
    end
    DB-->>A: NOTIFY pulse_events (job.updated)
    A-->>U: WebSocket push -> live UI update
```

## Failure isolation and recovery

- **Worker crash mid-job**: the reaper (running inside every worker process,
  serialized by an advisory lock so only one sweep executes at a time) detects
  workers whose heartbeat lease expired and requeues their in-flight jobs.
  See [DESIGN-DECISIONS.md § delivery semantics](DESIGN-DECISIONS.md).
- **Scheduler crash**: the standby instance's blocked `pg_try_advisory_lock`
  call succeeds the moment the dead leader's connection closes (Postgres
  releases session-level advisory locks on disconnect) — failover is
  automatic, no health check wiring required.
- **API crash**: stateless; a load balancer in front of multiple replicas
  is transparent to workers and the scheduler, which never talk to the API.
- **Database is the single point of failure** by design — see the trade-off
  discussion in DESIGN-DECISIONS.md for why this was accepted for this scope.
