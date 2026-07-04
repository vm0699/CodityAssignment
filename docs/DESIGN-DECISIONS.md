# Design decisions and trade-offs

This document is the "why", not the "what" — the what is in the code and in
[ARCHITECTURE.md](ARCHITECTURE.md) / [ER-DIAGRAM.md](ER-DIAGRAM.md).

## 1. Delivery semantics: at-least-once execution, exactly-once claiming

A distributed scheduler has to pick one of two failure modes, because a
worker can always die between "start the job" and "record that it finished."

- **Exactly-once claiming** *is* achieved: `claimJobs` runs `SELECT ... FOR
  UPDATE SKIP LOCKED` inside a transaction, guarded further by an advisory
  lock (`CLAIM_LOCK_KEY`). Two workers can never both transition the same job
  row from `queued → claimed`; Postgres's row lock makes that physically
  impossible, not just unlikely.
- **Exactly-once execution is not attempted.** If a worker is killed after
  starting a handler but before the `completeJob`/`failJob` write lands, the
  reaper will eventually requeue that job (its heartbeat lease expires) and
  it runs again. This is **at-least-once** delivery.

**Why accept at-least-once instead of building exactly-once execution:**
exactly-once execution across a crash requires either distributed
transactions with the side effect (rarely possible — you can't roll back an
email that was already sent) or a durable dedup log the *handler* must
consult. That's a much bigger system for marginal benefit, since most queued
work (webhooks, emails, cache warms, most business jobs) is naturally
idempotent or safe to occasionally repeat. The trade-off made instead:
`executeJob` hands every handler an `idempotencyKey` derived from `(job id,
attempt)`, and the docs/handler contract says handlers touching non-idempotent
external systems (payment capture, etc.) must use it to dedupe on their side
(e.g., Stripe's idempotency-key header). This pushes the decision to the one
place that actually knows whether it matters, instead of guessing platform-wide.

## 2. Why serialize claims with an advisory lock instead of relying only on `SKIP LOCKED`

`FOR UPDATE SKIP LOCKED` alone guarantees no two workers get the *same job
row*. It does **not** guarantee a queue's `max_concurrency` cap or
`rate_limit_per_second` is respected under concurrent claimers, because two
transactions can each read "3 of 5 slots free" from a stale snapshot and both
admit 3 more jobs — 6 running against a cap of 5.

The fix used here: `pg_advisory_xact_lock(CLAIM_LOCK_KEY)` at the top of
`claimJobs` serializes the *decision* of who gets to claim, cluster-wide, for
the duration of one fast (~1ms) transaction. This is a single global
bottleneck, and that's a deliberate, documented trade-off:

| Approach | Correctness | Throughput ceiling |
|---|---|---|
| No lock, `SKIP LOCKED` only | jobs never double-claimed, but concurrency/rate caps can be over-admitted under contention | highest |
| **Global advisory lock (chosen)** | caps are exact | bounded by claim-transaction latency (~1ms ⇒ ~1000 claims/sec cluster-wide, each claim batches up to `WORKER_CONCURRENCY` jobs) |
| Per-queue advisory lock (`hashtext(queue_id)`) | same exactness, scales with queue count | more complex; deferred — see "scaling path" below |

At the throughput this assignment targets, a single lock is not a bottleneck
(each claim call returns a *batch* of up to `WORKER_CONCURRENCY` jobs, so one
lock acquisition serves many jobs). The documented scaling path if this ever
matters: switch `CLAIM_LOCK_KEY` to `hashtext(queue_id::text)` so unrelated
queues stop contending with each other, at the cost of losing a single global
ordering guarantee across queues (which nothing currently relies on).

## 3. Why Postgres `LISTEN`/`NOTIFY` instead of Redis/RabbitMQ/Kafka

Every piece of coordination this platform needs — atomic claim, leader
election, event fan-out — has a native Postgres primitive. Adding a second
system (a broker, a cache, a lock service) means a second failure domain, a
second deployment artifact, and a second consistency model to reason about
for a feature (this assignment) that doesn't need broker-grade fan-out (millions
of subscribers, cross-datacenter replication, etc.).

The honest cost: `NOTIFY` payloads are capped at 8000 bytes and are
fire-and-forget (a listener that's disconnected at the moment of NOTIFY
simply misses it) — acceptable here because every consumer treats `NOTIFY`
as a *wake-up hint*, never as the source of truth. Workers still poll on a
fallback interval (`WORKER_POLL_INTERVAL_MS`) and the dashboard still polls
underneath its WebSocket subscription (`usePoll` in the frontend) — a missed
NOTIFY costs at most one poll interval of latency, never correctness. This is
the same reason the WebSocket gateway can restart or drop a client without
any special reconciliation logic: the client's next poll self-heals.

**When this would stop being the right call:** if this were a genuinely
high-fan-out system (thousands of independent consumers, or NOTIFY payloads
regularly exceeding 8KB), a real broker earns its complexity. For a scheduler
serving a project-scoped dashboard and a bounded worker fleet, it doesn't yet.

## 4. Why the scheduler is a leader-elected singleton, not a stateless replica set

Promoting a cron schedule to a job must happen **exactly once per fire time**
— firing it twice creates duplicate work, firing it zero times silently drops
a customer's report. Making the scheduler stateless and letting every replica
race to promote every due schedule would require the same serialization
problem the claim path already solves, applied to a much lower-volume
workload where the complexity isn't worth it.

Instead: `pg_try_advisory_lock` (session-level) elects exactly one active
scheduler; every other replica polls every 2 seconds to see if the lock
freed up. If the leader's Postgres connection drops (crash, network
partition), Postgres releases the session-level lock automatically —
failover requires no heartbeat protocol, no external coordinator, and no
split-brain window longer than one failed connection.

**Trade-off accepted:** standby scheduler replicas do no useful work. This is
fine because the scheduler's job (tick every `SCHEDULER_TICK_MS`, promote a
few rows) is cheap enough that "one active instance" is never a throughput
ceiling — the point of running more than one is availability, not scale.

**A second trade-off, made explicit rather than hidden:** cron materialisation
has **no catch-up/backfill**. If the scheduler is down when a schedule's
`next_run_at` passes, the next tick fires it once and reschedules from *now*
— a minutely job that missed an hour fires once, not sixty times. This
matches "cron job that's late" intuition (most cron systems don't replay
missed ticks either) and avoids a burst-of-sixty-jobs failure mode after any
outage. If true backfill semantics were required, `advanceSchedule` would
need to compute every missed occurrence instead of just `nextCronOccurrence`
from `now()` — deliberately not built, since it multiplies the blast radius
of any scheduler outage.

## 5. Configurable retry strategies and the Dead Letter Queue

Three backoff strategies (`fixed`, `linear`, `exponential`) share one
formula (`computeBackoffMs`) parameterized by `baseDelayMs`, `maxDelayMs`, and
an optional `jitterFactor`. Jitter is "AWS equal-jitter, lower half" —
`delay - delay * jitterFactor * random()` — chosen over full jitter
(`random() * delay`) because it guarantees a floor: a policy with
`jitterFactor: 0.3` never retries sooner than 70% of the computed delay, which
keeps backoff curves predictable for the dashboard to render and for an
operator to reason about, while still de-synchronising a thundering herd of
simultaneous retries.

The Dead Letter Queue is a **separate audit table**, not just a job status.
`dead_letter_jobs` snapshots the payload, the error, the attempt count, and
the (rule-based or AI) failure summary at the moment of dead-lettering —
independent of whatever happens to the job row afterward (requeue, further
edits). `dead_letter_active_job_idx` (partial unique on `job_id WHERE
requeued_at IS NULL`) enforces "at most one active DLQ entry" while still
preserving full history across repeated failure→requeue→failure cycles,
which the dashboard's "show requeued history" toggle surfaces directly.

## 6. Workflow dependencies without a separate DAG engine

`job_dependencies` is a plain edge table (`job_id → depends_on_job_id`).
Instead of building a DAG scheduler, dependency resolution reuses the
existing state machine: a child job is created with `status='scheduled'` and
`pending_dependencies = N`; each parent completion atomically decrements it
(`releaseDependents`, run inside the same transaction as `completeJob`), and
a child reaching zero is promoted straight to `queued`. Cascading
failure/cancellation walks the edge table with a recursive CTE
(`cancelDependentsCascade`) rather than a loop in application code — one
round-trip regardless of workflow depth.

**Trade-off:** this supports DAGs (a job can depend on multiple parents,
and multiple children can share a parent) but not cycle detection at
creation time beyond what the transaction naturally prevents (a job can't
depend on itself — `CHECK (job_id <> depends_on_job_id)` — and can't depend
on a job that doesn't exist yet, since dependency ids must already be real
rows). A determined caller could still construct A→B, B→C, C→A across three
separate `createJob` calls if each parent existed as a *different* job at
each call time... but since dependencies can only reference **already-existing**
job ids, and a job can't reference itself, true cycles are structurally
unreachable — you cannot create a job that depends on a job that doesn't
exist yet, which is the only way a cycle could form.

## 7. Rate limiting: two different limiters for two different resources

- **Per-queue dispatch rate limit** (`rate_limit_per_second` on the queue,
  enforced inside the same claim query as the concurrency cap) throttles how
  fast jobs are *handed to workers* — useful for "don't hammer a third-party
  API faster than N req/s" regardless of how many workers exist.
- **Per-user API rate limit** (in-memory token bucket in `apps/api/src/rate-limit.ts`)
  protects the control plane from abusive clients.

The API limiter is intentionally **in-memory, single-node**. Documented
scaling path: swap the `Map<string, Bucket>` for a Redis-backed token bucket
(or an API-gateway-level limiter) the moment the API runs as more than one
replica — noted directly in the code's docstring rather than silently
assumed to be production-ready as-is.

## 8. What would change at 100x scale

Being upfront about where this design's ceilings are, rather than only
describing what's here:

- **Claim lock contention**: shard `CLAIM_LOCK_KEY` per queue (see §2).
- **Single Postgres instance**: read replicas for the dashboard's read-heavy
  metrics/job-explorer queries; the claim/write path stays on the primary.
- **`jobs` table growth**: completed/dead-lettered jobs older than a
  retention window would move to a `jobs_archive` table (partitioned by
  month) — the partial indexes already ensure old rows don't slow down the
  hot claim/due scans, but table bloat still costs autovacuum time eventually.
- **In-memory API rate limiter**: move to Redis (§7).
- **WebSocket fan-out**: currently one LISTEN connection per API process; at
  very high event volume, a dedicated pub/sub relay (or a managed WS service)
  would decouple event ingestion from browser fan-out.

None of these were built, because building them now would be optimizing for
a scale this assignment doesn't operate at, at the cost of the schema/query
clarity that's actually being evaluated.
