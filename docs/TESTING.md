# Testing

```bash
npm run test:unit          # tests/unit — no database required
npm run test:integration   # tests/integration — requires: docker compose up -d db
npm test                    # both, via the Vitest workspace config
```

Current status: **52/52 passing** (29 unit, 23 integration).

## Why the suite is split into two Vitest "projects"

`vitest.workspace.ts` defines `unit` (pure functions, runs anywhere, no I/O)
and `integration` (hits a real Postgres). Keeping them separate means CI can
run unit tests on every push with zero setup, and only spins up a database
for the integration job. Integration tests run with `fileParallelism: false`
because they share one database with no per-test transaction rollback —
correctness depends on tests not stepping on each other's rows concurrently
(see "test isolation" below).

## Unit tests (`tests/unit/`)

Pure logic with no side effects, testing exactly the pieces that are easy to
get subtly wrong:

- **`retry.test.ts`** — all three backoff strategies, the delay cap, jitter
  bounds (with the RNG pinned to its extremes), overflow safety on huge
  attempt numbers.
- **`cron.test.ts`** — valid/invalid expressions, invalid timezones (this
  test caught a real gap: `cron-parser` silently accepts unknown IANA
  timezone strings — `validateCron` now checks the timezone explicitly with
  `Intl.DateTimeFormat` before parsing), next-occurrence math across a
  timezone boundary.
- **`state-machine.test.ts`** — every legal transition in the job lifecycle,
  proof that `completed` is truly terminal, that nonsensical jumps
  (`queued → running` without `claimed`) are rejected.
- **`validation.test.ts`** — the zod schemas the API uses: payload size caps,
  mutually-exclusive fields (`delayMs` vs `runAt`), status-list parsing.

## Integration tests (`tests/integration/`)

Run against a disposable `pulse_test` database (created automatically by
`db/init/01-create-test-db.sql` the first time the Postgres container boots).
`global-setup.ts` drops and recreates the `public` schema once per test run,
then applies migrations — every run starts from a known-empty schema.

- **`claim-concurrency.test.ts` — the money test.** Verifies the properties a
  reviewer would specifically probe for in a distributed scheduler:
  - 8 concurrent claimers racing over 60 jobs → **zero double-claims**, all
    60 claimed exactly once (`SELECT FOR UPDATE SKIP LOCKED` proof).
  - A queue capped at `max_concurrency=3`, hit with 6 simultaneous claim
    bursts of 10 → **exactly 3** admitted, a second simultaneous burst while
    those 3 are still in flight admits **zero** (the advisory-lock
    serialization proof — see [DESIGN-DECISIONS.md §2](DESIGN-DECISIONS.md)).
  - Queue priority beats job priority beats FIFO — and this test caught a
    real bug: `UPDATE ... RETURNING` does not preserve the priority order
    computed by the query's CTEs (Postgres has no ordering guarantee on
    `RETURNING`). Fixed by re-joining the update result to the ordered
    `picked` CTE and sorting explicitly — see the `claimJobs` query in
    `packages/core/src/repos/jobs.ts`.
  - Paused queues and not-yet-due delayed jobs are correctly invisible to
    claiming.
- **`lifecycle.test.ts`** — the full state machine end to end using the
  **real worker executor** (not a mock): a job runs through a real handler,
  produces an execution record, logs, and output; a policy-driven failure
  walks through exponential backoff (asserting the actual computed delay
  windows) across three attempts into the Dead Letter Queue, then is
  requeued and the DLQ entry is closed out; job timeouts are enforced via
  `AbortSignal`; workflow dependencies hold children until parents complete
  and release them atomically; cascade-cancellation of a whole dependency
  subtree; and the **reaper** — a worker's heartbeat is forced stale and the
  test proves its in-flight job is requeued and its execution marked
  `interrupted`.
- **`api.test.ts`** — the HTTP contract via `supertest` against the real
  Express app (no server binding, no separate process): registration/login,
  the structured error envelope, RBAC (a non-member gets 404, a viewer gets
  403 on writes), queue CRUD, job creation across all four modes (immediate,
  delayed, batch, idempotency-key deduplication), filtering/pagination,
  cron schedule creation and validation, and the scheduler's cron
  materialisation producing exactly one job even when ticked twice
  (idempotency-key collapse).

## Test isolation

Each test creates its **own** user/org/project/queue via `tests/integration/helpers.ts`
(`createFixture`), so tests never share mutable fixtures. The one thing to
know if you add a test: `claimJobs` with no queue filter claims from **every**
queue in the database, matching real worker behavior — tests that assert an
exact claimed count or order must pass their own queue id(s) as the
`queueFilter` argument (see `claim-concurrency.test.ts`), otherwise leftover
`queued` rows from earlier test files in the same run can be claimed too.
This is exactly the bug the priority-ordering test surfaced during
development, and is now the convention every concurrency test follows.

## What's deliberately not covered

- **Worker/scheduler process-level tests** (actual `SIGTERM` graceful
  shutdown, actual multi-process leader election) — the underlying logic
  (`requeueOrphanedJobs`, advisory-lock leader election) is covered directly;
  spinning up real child processes in the test suite would trade reliability
  for marginal additional confidence.
- **Frontend component tests** — verified manually end-to-end (see the demo
  walkthrough in the PR/session), since the dashboard's correctness is
  primarily "does it render the API's data and wire up the right calls",
  which integration-tests the API side already proves.
