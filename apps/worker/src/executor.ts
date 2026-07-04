import {
  appendJobLog,
  completeJob,
  createLogger,
  failJob,
  finishExecution,
  getPool,
  listJobLogs,
  markJobRunning,
  startExecution,
  type Job,
  type LogLevel,
} from '@pulse/core';
import { handlers } from './handlers.js';
import { maybeGenerateAiSummary, ruleBasedSummary } from './summarize.js';

const log = createLogger({ component: 'executor' });

/**
 * Runs one claimed job end to end: execution record, timeout enforcement,
 * log capture, then the success/failure lifecycle transition.
 *
 * At-least-once semantics: if this process dies mid-run the reaper requeues
 * the job. The (job id, attempt) pair is handed to handlers as an idempotency
 * key so external side effects can be deduplicated.
 */
export async function executeJob(job: Job, workerId: string): Promise<void> {
  const pool = getPool();

  const running = await markJobRunning(pool, job.id, workerId);
  if (!running) {
    // The job was cancelled (or reaped) between claim and start — let it go.
    log.info('job no longer runnable, skipping', { jobId: job.id });
    return;
  }

  const execution = await startExecution(pool, { jobId: job.id, attempt: job.attempt, workerId });
  const jobLog = async (level: LogLevel, message: string, context?: Record<string, unknown>) => {
    await appendJobLog(pool, { jobId: job.id, executionId: execution.id, workerId, level, message, context });
  };
  await jobLog('info', `attempt ${job.attempt} started on worker ${workerId.slice(0, 8)}`);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Job timed out after ${job.timeout_ms}ms`)),
    job.timeout_ms,
  );

  try {
    const handler = handlers[job.type];
    if (!handler) throw new Error(`No handler registered for job type '${job.type}'`);

    const output =
      (await handler(job.payload ?? {}, {
        job: running,
        log: jobLog,
        signal: controller.signal,
        idempotencyKey: `${job.id}:${job.attempt}`,
      })) ?? null;

    await finishExecution(pool, execution.id, 'completed', { output });
    const completed = await completeJob(job.id, workerId, output);
    if (completed) {
      await jobLog('info', `attempt ${job.attempt} completed`);
    } else {
      // Lost the race with a cancel/reap — record it, change nothing else.
      await jobLog('warn', 'completed locally but job state had moved on (cancelled or reaped)');
    }
  } catch (err) {
    const timedOut = controller.signal.aborted;
    const message = timedOut
      ? `Job timed out after ${job.timeout_ms}ms`
      : err instanceof Error
        ? `${err.name}: ${err.message}`
        : String(err);

    await finishExecution(pool, execution.id, timedOut ? 'timed_out' : 'failed', { error: message });
    await jobLog('error', `attempt ${job.attempt} failed: ${message}`);

    const summary = ruleBasedSummary({ ...job, attempt: job.attempt }, message);
    const outcome = await failJob(job.id, workerId, message, summary);
    if (outcome?.outcome === 'retry_scheduled') {
      await jobLog('info', `retry scheduled for ${outcome.nextRunAt?.toISOString()}`);
    } else if (outcome?.outcome === 'dead_letter') {
      await jobLog('error', 'attempts exhausted — moved to dead letter queue');
      const recent = await listJobLogs(pool, job.id, { limit: 20 });
      maybeGenerateAiSummary(job, message, recent.map((l) => `[${l.level}] ${l.message}`));
    }
  } finally {
    clearTimeout(timeout);
  }
}
