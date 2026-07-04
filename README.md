# Pulse — Distributed Job Scheduler

A production-inspired distributed job scheduling platform: authentication and
multi-tenant projects, configurable queues, five job creation modes
(immediate / delayed / scheduled / recurring cron / batch), a concurrent
polling worker fleet with atomic claiming and crash recovery, configurable
retry strategies with a Dead Letter Queue, workflow dependencies, and a live
web dashboard.

Built for the Codity intern assignment ([docs/PLAN.md](docs/PLAN.md) has the
full phased build plan).

## Contents

- [Architecture](docs/ARCHITECTURE.md) — components, data flow, diagram
- [Database design](docs/ER-DIAGRAM.md) — schema, ER diagram, indexing rationale
- [API reference](docs/API.md) — every endpoint, plus [openapi.yaml](docs/openapi.yaml)
- [Design decisions](docs/DESIGN-DECISIONS.md) — trade-offs and why
- [Testing](docs/TESTING.md) — what's covered and how to run it
- [Deployment](docs/DEPLOYMENT.md) — external requirements, environments, scaling

## Monorepo layout

```
packages/core      shared domain logic: db pool, migrations, repositories,
                    retry math, cron, state machine, pg NOTIFY event bus
apps/api            REST API + WebSocket gateway (Express)
apps/worker          polls queues, claims jobs atomically, executes, heartbeats
apps/scheduler       promotes due jobs, materialises cron schedules (leader-elected)
apps/web             React + Vite + Tailwind dashboard
tests/unit           pure-logic unit tests (retry math, cron, state machine, validation)
tests/integration    tests against a real Postgres (concurrency, lifecycle, API contract)
db/init              one-time Postgres container bootstrap (creates the test DB)
docker-compose.yml   dev Postgres, and a "full" profile for the whole stack
```

## Quick start (local development)

Requirements: Node.js 20+, Docker Desktop.

```bash
# 1. Install dependencies
npm install

# 2. Start Postgres (creates both `pulse` and `pulse_test` databases)
docker compose up -d db

# 3. Copy environment defaults
cp .env.example .env

# 4. Apply the schema
npm run migrate

# 5. Seed a demo workspace (login: demo@pulse.dev / demo1234)
npm run seed

# 6. Run everything (four terminals, or four backgrounded processes)
npm run dev:api        # http://localhost:4000
npm run dev:worker      # scale by running this command again in another terminal
npm run dev:scheduler   # safe to run more than once — only one becomes leader
npm run dev:web          # http://localhost:5173
```

Open http://localhost:5173, sign in with the seeded demo account, and the
dashboard is live: jobs are already flowing through queues, one is
intentionally flaky (exercises retries) and one is designed to exhaust its
retries into the Dead Letter Queue.

## Running the tests

```bash
npm run test:unit          # pure logic, no database needed
npm run test:integration   # needs `docker compose up -d db` (uses the pulse_test database)
npm test                   # both
```

See [docs/TESTING.md](docs/TESTING.md) for what each suite actually proves.

## Full containerized stack

```bash
docker compose --profile full up -d --build
docker compose --profile full up -d --scale worker=3   # horizontal worker scaling
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full external-requirements
checklist, environment variable matrix, and production notes.

## Demo job types

The worker ships with a small handler registry so the platform is fully
demoable without external dependencies:

| Type | Behavior |
|---|---|
| `demo.compute` | simulated CPU work with progress logs |
| `demo.sleep` | sleeps `payload.ms` — good for testing concurrency/timeouts |
| `demo.flaky` | fails with probability `payload.failureRate` — exercises retries |
| `demo.fail` | always fails — deterministic Dead Letter Queue demo |
| `email.send` | simulated transactional email delivery |
| `http.request` | real outbound HTTP call, timeout-enforced via `AbortSignal` |

## Bonus features implemented

Workflow dependencies (DAG job graphs), distributed locking (Postgres
advisory locks for scheduler leader election and claim serialization), queue
sharding (worker `WORKER_QUEUE_FILTER`), event-driven execution
(`LISTEN`/`NOTIFY` wakes workers instantly instead of pure polling),
WebSocket live dashboard updates, role-based access control (owner / admin /
member / viewer), rate limiting (per-queue dispatch + per-user API), and
AI-generated failure summaries (rule-based always-on, upgraded to an LLM
summary when `ANTHROPIC_API_KEY` is set).
