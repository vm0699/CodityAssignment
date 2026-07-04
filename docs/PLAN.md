# Implementation Plan — Distributed Job Scheduler

This document is the master plan for the project. It breaks delivery into **phases**, each with
**stages** and clear exit criteria. The assignment weights (Architecture 20, Database 20,
Backend 20, Reliability & Concurrency 15, Frontend 10, API 5, Docs 5, Testing 5) drove the
effort allocation: correctness, concurrency-safety and schema quality come first; features second.

## Guiding decisions (summary — full rationale in DESIGN-DECISIONS.md)

| Decision | Choice | Why |
|---|---|---|
| Database | PostgreSQL 16 | `FOR UPDATE SKIP LOCKED` gives lock-free-contention atomic claiming; advisory locks give distributed leader election; `LISTEN/NOTIFY` gives event-driven wake-ups — all three are core to a scheduler. |
| Data access | Hand-written SQL + `pg` (no ORM) | The schema *is* the product here; explicit SQL makes indexes, locking and transactions visible and reviewable. |
| Language | TypeScript (Node 22) end to end | One language across API, worker, scheduler and dashboard; shared domain package eliminates drift. |
| Layout | npm-workspaces monorepo | `packages/core` (domain + persistence) is consumed by three services; clean modular boundaries. |
| API | Express 4 + zod validation | Small, explicit, easy to audit. OpenAPI 3 spec is written alongside. |
| Live updates | WebSocket fed by Postgres `LISTEN/NOTIFY` | Workers publish state changes through the DB, the API fans out to browsers — no extra broker needed. |
| Frontend | React 18 + Vite + Tailwind + Recharts | Fast to build, responsive, professional dashboard look. |
| Tests | Vitest (+ supertest) | Unit tests for pure domain logic; integration tests against a real Postgres for concurrency claims. |

## Delivery semantics

The platform provides **at-least-once** execution with **exactly-once claiming**:

- *Exactly-once claiming*: a job row can only move `queued → claimed` inside one
  `FOR UPDATE SKIP LOCKED` transaction, so two workers can never both claim the same attempt.
- *At-least-once execution*: if a worker dies mid-run, the reaper requeues the job after its
  heartbeat lease expires — the job may run again. Handlers are therefore given an
  `idempotency key` (job id + attempt) and the docs mandate idempotent handler design.

---

## Phase 0 — Foundations
| Stage | Work | Exit criteria |
|---|---|---|
| 0.1 | Monorepo scaffold: root `package.json` (workspaces), shared `tsconfig`, `.gitignore`, `.env.example`, git init | `npm install` clean |
| 0.2 | `docker-compose.yml` with Postgres 16 (+ full-stack profiles for api/worker/scheduler/web) | `docker compose up db` healthy |
| 0.3 | This plan + doc skeletons | docs/ populated |

## Phase 1 — Database (schema is the contract)
| Stage | Work | Exit criteria |
|---|---|---|
| 1.1 | Migration runner (ordered SQL files, `schema_migrations` ledger, advisory-locked) | idempotent re-runs |
| 1.2 | Migration 001: enums + core tables — users, organizations, organization_members, projects, queues, retry_policies, jobs, job_executions, job_logs, scheduled_jobs, workers, worker_heartbeats, dead_letter_jobs, job_dependencies | applies cleanly |
| 1.3 | Indexes tuned for the hot paths: claim scan (partial index on `status='queued'`), due-scan for scheduler, job explorer filters, FK indexes | EXPLAIN-verified shapes documented |
| 1.4 | Seed script: demo org/project/queues/jobs/users | `npm run seed` |

## Phase 2 — Core domain package (`packages/core`)
| Stage | Work | Exit criteria |
|---|---|---|
| 2.1 | pg pool, typed query helper, transaction helper | unit-testable |
| 2.2 | Retry strategies: fixed / linear / exponential (+ jitter, caps) | unit tests |
| 2.3 | Job state machine (legal transitions enforced in one place) | unit tests |
| 2.4 | Cron: parse/validate/next-occurrence (cron-parser) | unit tests |
| 2.5 | Repositories: users, orgs, projects, queues, jobs, executions, logs, workers, scheduled jobs, DLQ | used by all services |
| 2.6 | Atomic claim query (`SKIP LOCKED` CTE honouring queue priority, job priority, concurrency caps, paused flag) | race-tested in Phase 6 |
| 2.7 | Event bus: `pg_notify` publish + LISTEN subscriber with reconnect | events flow |

## Phase 3 — REST API (`apps/api`)
| Stage | Work | Exit criteria |
|---|---|---|
| 3.1 | App skeleton: pino logging, request ids, structured error envelope, zod validation middleware | consistent errors |
| 3.2 | Auth: register/login (bcrypt + JWT), auth middleware, RBAC middleware (owner/admin/member/viewer) | 401/403 paths tested |
| 3.3 | Orgs & projects CRUD, membership management | |
| 3.4 | Queues: CRUD, pause/resume, retry-policy config, per-queue stats | |
| 3.5 | Jobs: create (immediate/delayed/scheduled/cron/batch), list w/ pagination+filters, detail (executions, logs), cancel, retry-now, priority | |
| 3.6 | Workers: list + heartbeat freshness; DLQ: list/inspect/requeue/discard; Scheduled jobs: CRUD/pause | |
| 3.7 | Metrics endpoints: throughput time-series, status counts, queue depth, success rate | dashboard-ready |
| 3.8 | Rate limiting (token bucket), WebSocket endpoint bridging DB events, OpenAPI spec | |

## Phase 4 — Worker service (`apps/worker`)
| Stage | Work | Exit criteria |
|---|---|---|
| 4.1 | Worker registration + heartbeat loop (lease-based liveness) | visible in dashboard |
| 4.2 | Poll loop + LISTEN wake-up; atomic batch claim respecting local concurrency slots | no duplicate claims under race |
| 4.3 | Handler registry + sample handlers (http.request, email.send, demo.compute, demo.flaky, demo.sleep) | jobs execute |
| 4.4 | Execution records, log capture, timeout enforcement per job | |
| 4.5 | Failure path: retry scheduling per policy → DLQ after max attempts; AI/rule-based failure summary | |
| 4.6 | Graceful shutdown (stop claiming, drain running, final heartbeat) + stale-worker reaper (requeue orphaned jobs) | kill -SIGTERM drains |

## Phase 5 — Scheduler service (`apps/scheduler`)
| Stage | Work | Exit criteria |
|---|---|---|
| 5.1 | Leader election via Postgres advisory lock (any number of replicas, one active) | failover works |
| 5.2 | Due-scan: promote `scheduled → queued` (delayed/scheduled/retry-wait jobs) | second-level precision |
| 5.3 | Cron materializer: create next job instance per scheduled_job, compute `next_run_at`, catch-up policy | no double-fires |
| 5.4 | Dependency resolver: release children when parents complete; fail/skip children on parent failure | workflow demo |

## Phase 6 — Automated tests
| Stage | Work | Exit criteria |
|---|---|---|
| 6.1 | Unit: retry math, cron, state machine, pagination/validation | `npm test` green |
| 6.2 | Integration: auth flows, queue/job CRUD, filters | |
| 6.3 | Concurrency: N parallel claimers × M jobs → zero duplicates; concurrency-cap respected; pause respected | the money test |
| 6.4 | Lifecycle: fail → backoff retries → DLQ; requeue from DLQ; reaper recovers orphaned jobs | |

## Phase 7 — Web dashboard (`apps/web`)
| Stage | Work | Exit criteria |
|---|---|---|
| 7.1 | Auth screens, app shell, project switcher, API client, live-update hook (WS + polling fallback) | |
| 7.2 | Overview: KPI cards, throughput chart, status breakdown, queue depth, worker health | |
| 7.3 | Queues: table + config editor (priority, concurrency, retry policy), pause/resume, per-queue stats | |
| 7.4 | Job explorer: filterable/paginated table, job detail drawer (payload, executions, logs, timeline), retry/cancel actions, batch & cron creation forms | |
| 7.5 | Workers page, DLQ page (requeue/discard), Scheduled jobs page | |

## Phase 8 — Documentation & deployment
| Stage | Work | Exit criteria |
|---|---|---|
| 8.1 | ARCHITECTURE.md + component diagram; ER-DIAGRAM.md (mermaid) | |
| 8.2 | API.md + OpenAPI yaml | |
| 8.3 | DESIGN-DECISIONS.md (locking, delivery semantics, schema trade-offs, scaling) | |
| 8.4 | README (quick start), DEPLOYMENT.md (compose prod profile, env matrix, scaling workers), TESTING.md | fresh-clone bring-up verified |
