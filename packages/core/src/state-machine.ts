import type { JobStatus } from './types.js';

/**
 * The single source of truth for legal job transitions. Every status write in
 * the platform goes through guarded SQL (`WHERE status = ANY(from)`) built
 * from this map, so an illegal transition is impossible even under races.
 *
 *   scheduled ──▶ queued ──▶ claimed ──▶ running ──▶ completed
 *       ▲            ▲                      │
 *       │            │                      ├──▶ failed ──▶ scheduled (retry)
 *       │            │                      │        └────▶ dead_letter
 *       └── retry ───┴───── reaper requeue ─┘
 *   (cancelled is reachable from every non-terminal state)
 */
export const JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  scheduled: ['queued', 'cancelled'],
  queued: ['claimed', 'cancelled', 'scheduled'], // scheduled: pause-drain / dependency added
  claimed: ['running', 'queued', 'cancelled'], // queued: reaper requeue of a dead worker's claim
  running: ['completed', 'failed', 'queued', 'cancelled'], // queued: reaper requeue
  failed: ['scheduled', 'dead_letter', 'queued'], // scheduled: backoff retry; queued: manual retry
  completed: [],
  dead_letter: ['queued'], // manual requeue from the DLQ
  cancelled: ['queued'], // manual re-run
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from]?.includes(to) ?? false;
}

/** States from which `to` is legally reachable — used to build guarded UPDATEs. */
export function sourcesOf(to: JobStatus): JobStatus[] {
  return (Object.keys(JOB_TRANSITIONS) as JobStatus[]).filter((from) =>
    JOB_TRANSITIONS[from].includes(to),
  );
}

export const TERMINAL_STATUSES: JobStatus[] = ['completed'];
export const IN_FLIGHT_STATUSES: JobStatus[] = ['claimed', 'running'];
