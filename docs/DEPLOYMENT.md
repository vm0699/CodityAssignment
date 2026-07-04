# Deployment guide

## External requirements

| Requirement | Version | Purpose |
|---|---|---|
| **Node.js** | 20+ (built with 22) | runs all four services |
| **PostgreSQL** | 16 (uses `gen_random_uuid`, partial/expression indexes, `LISTEN`/`NOTIFY`, advisory locks — all standard since PG 9.x–13, nothing exotic) | the only stateful dependency |
| **Docker + Docker Compose** | current | local Postgres and/or full containerized stack |
| npm workspaces | (bundled with Node) | monorepo dependency management |

Nothing else is required to run the full feature set. Two integrations are
**optional, gracefully degrading**:

- `ANTHROPIC_API_KEY` — if unset, dead-lettered jobs still get an instant
  **rule-based** failure summary (`apps/worker/src/summarize.ts`); if set, an
  LLM-generated summary replaces it asynchronously, fire-and-forget (never
  blocks the job pipeline, never fails a job if the API call errors).
- A reverse proxy / TLS terminator in front of the API and web containers for
  production (not included — this repo ships HTTP for local/dev clarity).

## Environment variables

See [.env.example](../.env.example) for the full annotated list. The ones
that matter for a first deployment:

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | required by every service |
| `JWT_SECRET` | — | **must be changed** for anything beyond local dev |
| `API_PORT` | 4000 | |
| `CORS_ORIGIN` | `http://localhost:5173` | set to the deployed dashboard origin |
| `WORKER_CONCURRENCY` | 5 | jobs one worker process runs in parallel |
| `WORKER_QUEUE_FILTER` | unset (all queues) | comma-separated queue ids — use to shard specific workers to specific queues |
| `WORKER_LEASE_TIMEOUT_MS` | 30000 | how long a worker can go silent before its jobs are reclaimed |
| `SCHEDULER_TICK_MS` | 1000 | cron/due-job promotion frequency |
| `ANTHROPIC_API_KEY` | unset | optional, enables AI failure summaries |
| `VITE_API_URL` | `http://localhost:4000` | baked into the web build at build time |

## Local development

```bash
docker compose up -d db
cp .env.example .env
npm install && npm run migrate && npm run seed
npm run dev:api & npm run dev:worker & npm run dev:scheduler & npm run dev:web &
```

## Full containerized stack

```bash
docker compose --profile full up -d --build
```

This builds and runs `api`, `worker`, `scheduler` (2 replicas — proves leader
election, see [DESIGN-DECISIONS.md §4](DESIGN-DECISIONS.md)), and `web`
(nginx-served static build) alongside `db`. Each service's `Dockerfile` lives
next to its source (`apps/*/Dockerfile`) and is built from the **repo root**
context so it can pull in `packages/core`.

**Scaling workers horizontally:**
```bash
docker compose --profile full up -d --scale worker=5
```
Every worker registers its own row in `workers` and independently claims
jobs — no coordination needed beyond what's already in the claim query.

**Migrations on container start:** the `api`, `worker`, and `scheduler`
services all run `runMigrations()` on boot (guarded by an advisory lock, so
it's safe for all three to race to migrate simultaneously — see
`packages/core/src/migrate.ts`). Set `RUN_MIGRATIONS=false` on services after
the first deploy if you prefer migrations to be a separate release step.

## Production checklist

- [ ] Set a strong, unique `JWT_SECRET` (32+ random bytes).
- [ ] Point `DATABASE_URL` at a managed Postgres instance with backups
      enabled; the schema has no Postgres-version-specific extensions beyond
      `pgcrypto` (for `gen_random_uuid`), which is available on every managed
      provider (RDS, Cloud SQL, Supabase, Neon, etc.).
- [ ] Put a reverse proxy (nginx/Caddy/ALB) in front of `api` and `web` for
      TLS; the WebSocket upgrade (`/ws`) must be proxied through untouched
      (`Upgrade`/`Connection` headers preserved).
- [ ] Set `CORS_ORIGIN` to the real dashboard origin (not `*`).
- [ ] Move the API rate limiter to a shared store (Redis) the moment the API
      runs as more than one replica — the current in-memory token bucket is
      explicitly single-node (see `apps/api/src/rate-limit.ts` and
      [DESIGN-DECISIONS.md §7](DESIGN-DECISIONS.md)).
- [ ] Decide a retention/archival policy for `jobs`/`job_logs`/`job_executions`
      before the table grows unbounded (see
      [DESIGN-DECISIONS.md §8](DESIGN-DECISIONS.md)).
- [ ] Wire container health checks to `GET /api/health` for the API and a
      process-liveness check (heartbeat freshness in the `workers` table) for
      workers.
- [ ] Set `ANTHROPIC_API_KEY` if AI failure summaries are wanted in production
      triage.

## Scaling model at a glance

| Component | Scales by | Coordination needed |
|---|---|---|
| API | more replicas behind a load balancer | none — fully stateless |
| Worker | more replicas / `--scale worker=N` | none — atomic claim handles contention |
| Scheduler | more replicas for **availability** only | automatic (advisory-lock leader election) |
| Postgres | vertical, or read replicas for dashboard queries | the claim/write path must stay on the primary |
