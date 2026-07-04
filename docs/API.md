# API reference

Base URL: `http://localhost:4000/api` (dev). Machine-readable spec:
[openapi.yaml](openapi.yaml).

## Conventions

- **Auth**: `Authorization: Bearer <jwt>` on every endpoint except
  `/auth/register`, `/auth/login`, and `/health`.
- **Errors**: every non-2xx response is `{ "error": { "code", "message",
  "details"? } }`. `details` is populated for `VALIDATION_ERROR` with one
  entry per failed field (`{ path, message }`).
- **Pagination**: list endpoints accept `?limit=25&offset=0` (max `limit`
  200) and respond `{ "data": [...], "pagination": { "total", "limit",
  "offset" } }`.
- **RBAC**: four roles per organization — `owner > admin > member > viewer`.
  A caller with no membership in the resource's organization gets `404` (not
  `403`) so resource existence is never leaked to non-members.
- **Idempotency**: pass `idempotencyKey` when creating a job to deduplicate
  retried client submissions; a repeat call returns the original job with
  `deduplicated: true` and HTTP 200 instead of 201.

## Auth

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Create a user (+ a starter organization). Returns `{ token, user, organization }`. |
| POST | `/auth/login` | — | Returns `{ token, user }`. |
| GET | `/auth/me` | authenticated | Current user + organization memberships. |

## Organizations & members (RBAC)

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/orgs` | authenticated | Organizations the caller belongs to, with role. |
| POST | `/orgs` | authenticated | Create an organization (caller becomes owner). |
| GET | `/orgs/:orgId/members` | viewer | List members. |
| POST | `/orgs/:orgId/members` | admin | Add a member by email: `{ email, role }`. |
| DELETE | `/orgs/:orgId/members/:userId` | admin | Remove a member (cannot remove the owner). |

## Projects

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/projects` | authenticated | Projects across all the caller's organizations. |
| POST | `/projects/orgs/:orgId` | admin | Create a project: `{ name, slug, description? }`. |
| GET | `/projects/:projectId` | viewer | Project detail. |
| PATCH | `/projects/:projectId` | admin | Update `{ name?, description? }`. |
| DELETE | `/projects/:projectId` | owner | Delete (cascades to queues/jobs). |

## Retry policies (project-scoped)

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/projects/:projectId/retry-policies` | viewer | List. |
| POST | `/projects/:projectId/retry-policies` | member | Create: `{ name, strategy, maxAttempts, baseDelayMs, maxDelayMs, jitterFactor? }`. |
| PATCH | `/retry-policies/:policyId` | member | Partial update. |
| DELETE | `/retry-policies/:policyId` | admin | Delete (queues using it fall back to the system default). |

## Queues

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/projects/:projectId/queues` | viewer | List queues. |
| GET | `/projects/:projectId/queues/stats` | viewer | Per-queue status counts + 24h success rate / avg duration. |
| POST | `/projects/:projectId/queues` | member | Create: `{ name, description?, priority?, maxConcurrency?, retryPolicyId?, rateLimitPerSecond? }`. |
| GET | `/queues/:queueId` | viewer | Queue detail. |
| PATCH | `/queues/:queueId` | member | Partial update of any creation field. |
| POST | `/queues/:queueId/pause` | member | Stop the queue from being claimed from. |
| POST | `/queues/:queueId/resume` | member | Resume claiming. |
| DELETE | `/queues/:queueId` | admin | Delete (cascades to its jobs). |

## Jobs

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/queues/:queueId/jobs` | member | Create one job — see body schema below. |
| POST | `/queues/:queueId/jobs/batch` | member | Create many jobs atomically: `{ jobs: [ <job body>, ... ] }` (max 500), sharing one `batchId`. |
| GET | `/projects/:projectId/jobs` | viewer | Filterable, paginated list — see query params below. |
| GET | `/jobs/:jobId` | viewer | Full detail: job + `executions[]` (retry history) + `dependencies`. |
| GET | `/jobs/:jobId/logs?afterId=0` | viewer | Structured log lines (`afterId` for incremental polling). |
| POST | `/jobs/:jobId/cancel` | member | Cancel a non-terminal job (cascades to dependents). |
| POST | `/jobs/:jobId/retry` | member | Immediately requeue a failed / dead-lettered / cancelled / scheduled job. |

**Job creation body:**
```jsonc
{
  "type": "email.send",           // required — handler key
  "payload": { "to": "a@b.co" },   // optional, <= 64KB serialized
  "priority": 0,                    // optional, -1000..1000
  "delayMs": 60000,                 // optional — mutually exclusive with runAt
  "runAt": "2026-01-01T00:00:00Z", // optional — absolute schedule time
  "timeoutMs": 60000,                // optional, 100..3600000
  "maxAttempts": 5,                  // optional — overrides the queue's retry policy
  "idempotencyKey": "charge-42",     // optional — dedupes retried submissions
  "dependsOn": ["<parent job id>"]  // optional — workflow dependency, up to 50 parents
}
```

**Job list query params** (`GET /projects/:projectId/jobs`): `queueId`,
`status` (comma-separated, e.g. `queued,running`), `type`, `batchId`,
`scheduledJobId`, `workerId`, `search` (id prefix or type substring),
`createdAfter`, `createdBefore`, `limit`, `offset`.

## Recurring schedules (cron)

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/projects/:projectId/schedules` | viewer | List, with a human-readable `cron_description`. |
| POST | `/projects/:projectId/schedules` | member | Create: `{ queueId, name, cronExpression, timezone?, jobType, payload?, priority?, timeoutMs?, maxAttempts? }`. |
| PATCH | `/schedules/:scheduleId` | member | Update any field, or `{ status: "paused" | "active" }`. |
| DELETE | `/schedules/:scheduleId` | member | Delete (already-created job instances are kept). |

## Workers

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/workers` | authenticated | Fleet view: status, load (`running_jobs`/`concurrency`), heartbeat freshness. |

## Dead Letter Queue

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/projects/:projectId/dlq` | viewer | Paginated; `?includeRequeued=true` to see closed-out history too. |
| POST | `/dlq/:entryId/requeue` | member | Puts the underlying job back on the queue. |
| DELETE | `/dlq/:entryId` | admin | Permanently deletes the job and its history (destructive). |

## Metrics

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/projects/:projectId/metrics/overview` | viewer | Status counts, last-hour throughput, DLQ backlog, worker count, p95/avg duration, oldest-queued-age. |
| GET | `/projects/:projectId/metrics/throughput?windowMinutes=60&bucketSeconds=60` | viewer | Time-bucketed created/completed/failed series for the dashboard chart. |

## Live updates

`GET /ws?token=<jwt>&projectId=<uuid>` — WebSocket. After an initial
`{"kind":"connected"}` frame, pushes `PulseEvent` frames
(`job.created`/`job.updated`/`queue.updated`/`worker.updated`/`dlq.updated`/`schedule.updated`)
scoped to the given project (worker events are global). The dashboard treats
these purely as "something changed, refetch" hints — see
[DESIGN-DECISIONS.md §3](DESIGN-DECISIONS.md).

## Health

`GET /health` — `{ status: "ok"|"degraded", database: "up"|"down", time }`.
No auth required; used for container/orchestrator health checks.
