# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Pulse — a distributed job scheduling platform (Postgres-backed, no external
broker). npm-workspaces monorepo: `packages/core` (shared domain logic +
persistence) consumed by three backend services (`apps/api`, `apps/worker`,
`apps/scheduler`) plus a React dashboard (`apps/web`). Full design rationale
lives in `docs/` — read `docs/DESIGN-DECISIONS.md` before changing anything
in the claim/retry/scheduling paths, since several things that look like bugs
(a global advisory lock serializing every claim, no cron catch-up/backfill,
at-least-once rather than exactly-once execution) are deliberate trade-offs
explained there.

## Commands

```bash
# Setup (once)
docker compose up -d db          # Postgres 16, creates both `pulse` and `pulse_test` dbs
cp .env.example .env
npm install
npm run migrate                   # applies packages/core/migrations/*.sql
npm run seed                        # demo workspace: demo@pulse.dev / demo1234

# Run services (each in its own terminal / background process)
npm run dev:api                     # http://localhost:4000
npm run dev:worker                    # safe to run multiple times to scale
npm run dev:scheduler                  # safe to run multiple times — one becomes leader
npm run dev:web                          # http://localhost:5173

# Tests
npm run test:unit                        # tests/unit — no database needed
npm run test:integration                  # tests/integration — needs `docker compose up -d db`
npm test                                    # both
npx vitest run tests/unit/retry.test.ts       # a single file
npx vitest run -t "respects queue priority"    # a single test by name (integration project)

# Typecheck every workspace
npm run typecheck

# Full containerized stack
docker compose --profile full up -d --build
docker compose --profile full up -d --scale worker=3
```

There is no lint script configured; rely on `npm run typecheck` and the test
suites for correctness checks.

## Architecture

### The three backend services talk only through Postgres

No message broker, no Redis, no RPC between services. All coordination uses
three Postgres primitives:
- **`SELECT ... FOR UPDATE SKIP LOCKED`** — atomic job claiming (`claimJobs`
  in `packages/core/src/repos/jobs.ts`). Also serialized by a global advisory
  lock (`CLAIM_LOCK_KEY`) so per-queue `max_concurrency` and
  `rate_limit_per_second` are exact under contention, not just "no duplicate
  claims" — see DESIGN-DECISIONS.md §2 before changing this query.
- **Advisory locks** — the scheduler's leader election
  (`apps/scheduler/src/index.ts`, `pg_try_advisory_lock`, session-level so it
  releases automatically if the leader's connection dies) and the worker
  reaper (`pg_try_advisory_xact_lock`, so only one worker's reaper sweep runs
  at a time even though every worker process runs one).
- **`LISTEN`/`NOTIFY`** — `packages/core/src/events.ts`. `WAKE_CHANNEL` wakes
  workers near-instantly instead of waiting for their poll interval;
  `EVENTS_CHANNEL` is what the API's WebSocket gateway (`apps/api/src/ws.ts`)
  subscribes to and fans out to browsers. Every consumer treats these as
  wake-up *hints* — nothing depends on a NOTIFY arriving, since polling is
  always the fallback.

### Job lifecycle is one state machine, enforced everywhere

`packages/core/src/state-machine.ts` (`JOB_TRANSITIONS`) is the single source
of truth for legal status transitions. Every SQL UPDATE that changes a job's
status guards it with `WHERE status IN (...)` matching that map, so an
illegal transition is structurally impossible even under a race — don't
write a status UPDATE without checking this map first. The lifecycle:
`scheduled → queued → claimed → running → completed`, with `failed` looping
back to `scheduled` (retry) or forward to `dead_letter`, and `cancelled`
reachable from any non-terminal state. Retry backoff math lives in
`packages/core/src/retry.ts` (`computeBackoffMs`) and is deliberately
independent of any storage — it's pure so it's trivially unit-testable.

### Where logic lives vs. where it's exposed

`packages/core` owns *everything* stateful and cross-cutting: db pool,
migrations (`migrate.ts`, advisory-locked, safe for all three services to run
concurrently on boot), all repositories (`src/repos/*.ts`), the event bus,
cron helpers, retry math, and the state machine. `apps/api` is a thin HTTP/WS
layer over those repositories plus auth/RBAC/validation — it should not
contain business logic that belongs in core. `apps/worker`'s only real logic
is the handler registry (`src/handlers.ts`) and the execute-one-job flow
(`src/executor.ts`); claiming, retry scheduling, and DLQ transitions are all
core repository calls. `apps/scheduler` is two functions
(`promoteDueJobs`, `materialiseCronSchedules` in `src/tick.ts`) plus the
leader-election loop.

### RBAC and multi-tenancy shape every query

Four roles per organization (`owner > admin > member > viewer`,
`packages/core/src/types.ts` `OrgRole`). `apps/api/src/auth.ts`
(`assertProjectRole`) resolves a project's org and checks role there — a
caller with no membership gets `404`, never `403`, so resource existence is
never leaked to non-members. Every project-scoped route goes through this
check; when adding a new project-scoped endpoint, follow the pattern in
`apps/api/src/routes/queues.ts` (`loadQueueChecked`) rather than querying the
resource before checking access.

### Dependencies (workflow DAGs) reuse the state machine, not a separate engine

`jobs.pending_dependencies` is decremented transactionally as each parent
completes (`releaseDependents`, called inside `completeJob`); a child hits
zero and is promoted straight to `queued`. Cascading cancellation on
failure/cancel walks the `job_dependencies` edge table with one recursive CTE
(`cancelDependentsCascade`) rather than looping in application code.

### Frontend data flow

Every page uses `usePoll` (`apps/web/src/hooks.ts`) for its data — polls on
an interval AND refetches immediately when `useLiveEvents`'s WebSocket
subscription fires a debounced tick. There is no client-side cache/store
beyond that; adding a new dashboard page means wiring `usePoll` to the
relevant API endpoint and reacting to `liveTick` from `useApp()`
(`apps/web/src/App.tsx`), matching the existing pages under `apps/web/src/pages/`.

### Test isolation gotcha

`claimJobs` with no queue filter claims from **every** queue in the database
— matching real worker behavior. Integration tests share one Postgres
database across files in a run (`fileParallelism: false`, one schema reset
per run in `tests/integration/global-setup.ts`, not per test). Any test
asserting an exact claimed count or order must pass its own queue id(s) as
the `queueFilter` argument to `claimJobs`, or leftover `queued` rows from
earlier tests in the same run will be claimed too (see
`tests/integration/claim-concurrency.test.ts` and the note in
`docs/TESTING.md`).
