-- ============================================================================
-- Migration 002 — System events (operational activity feed)
--
-- A lightweight, append-only feed of infrastructure-level events: worker
-- registration, atomic claim batches, reaper recoveries, scheduler leader
-- election, cron fires, and dead-letter moves. Distinct from job_logs (which
-- is per-job execution detail) — this table answers "what is the platform's
-- machinery doing right now", and is what the dashboard's Activity page
-- tails live, so the concurrency/reliability engineering is visible in the
-- product itself rather than only in server console output.
-- ============================================================================

CREATE TABLE system_events (
  id         bigserial PRIMARY KEY,
  level      log_level NOT NULL DEFAULT 'info',
  component  text NOT NULL,
  message    text NOT NULL,
  context    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Tail query ("most recent N events") and the pruning sweep both scan by time.
CREATE INDEX system_events_created_idx ON system_events (created_at);
CREATE INDEX system_events_component_idx ON system_events (component, created_at DESC);
