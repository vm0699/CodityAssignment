import { createLogger, getPool, type Job } from '@pulse/core';

const log = createLogger({ component: 'summarize' });

/**
 * Failure triage summaries for dead-lettered jobs.
 *
 * Always produces an instant rule-based summary. When ANTHROPIC_API_KEY is
 * set, an LLM-written summary is generated asynchronously (fire-and-forget)
 * and replaces the rule-based one — the job pipeline never waits on the API.
 */

export function ruleBasedSummary(job: Job, error: string): string {
  const e = error.toLowerCase();
  let diagnosis: string;
  if (e.includes('timed out') || e.includes('timeout') || e.includes('aborterror')) {
    diagnosis = `The job exceeded its ${job.timeout_ms}ms timeout. Consider raising timeout_ms, breaking the work into smaller jobs, or checking the downstream service's latency.`;
  } else if (e.includes('econnrefused') || e.includes('enotfound') || e.includes('fetch failed') || e.includes('socket')) {
    diagnosis = 'A network dependency was unreachable. Verify the target host, DNS and firewall rules; retries alone will not fix a persistent connectivity problem.';
  } else if (e.includes('unexpected status 5')) {
    diagnosis = 'The downstream HTTP service kept returning 5xx errors across every retry — the failure is on their side. Check the service health before requeueing.';
  } else if (e.includes('unexpected status 4')) {
    diagnosis = 'The downstream HTTP service returned a 4xx error, which usually means the request itself is wrong (bad URL, auth, or payload). Retrying the same request will keep failing.';
  } else if (e.includes('invalid') || e.includes('must be')) {
    diagnosis = 'The payload appears malformed for this handler. Fix the payload and requeue; retries cannot succeed with the same input.';
  } else if (e.includes('no handler')) {
    diagnosis = `No handler is registered for job type '${job.type}'. Deploy a worker that implements it or fix the job type.`;
  } else if (e.includes('simulated')) {
    diagnosis = 'This is a demo job that failed by design (simulated failure rate). Nothing to fix.';
  } else {
    diagnosis = 'The handler threw the same class of error on every attempt, so this looks deterministic rather than transient. Inspect the execution logs before requeueing.';
  }
  return `Job '${job.type}' exhausted ${job.attempt} attempt(s). Last error: "${truncate(error, 160)}". ${diagnosis}`;
}

export function maybeGenerateAiSummary(job: Job, error: string, recentLogs: string[]): void {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;
  void (async () => {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [
            {
              role: 'user',
              content:
                `A background job permanently failed after ${job.attempt} attempts. Write a 2-3 sentence triage summary for the on-call engineer: likely root cause and the most useful next step. Be specific, no preamble.\n\n` +
                `Job type: ${job.type}\nPayload: ${JSON.stringify(job.payload).slice(0, 1500)}\n` +
                `Final error: ${error.slice(0, 1500)}\nRecent logs:\n${recentLogs.join('\n').slice(0, 2000)}`,
            },
          ],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`Anthropic API returned ${response.status}`);
      const data = (await response.json()) as { content: Array<{ type: string; text?: string }> };
      const text = data.content.find((c) => c.type === 'text')?.text?.trim();
      if (!text) return;
      const summary = `[AI] ${text}`;
      await getPool().query(`UPDATE jobs SET failure_summary = $2 WHERE id = $1`, [job.id, summary]);
      await getPool().query(
        `UPDATE dead_letter_jobs SET failure_summary = $2 WHERE job_id = $1 AND requeued_at IS NULL`,
        [job.id, summary],
      );
      log.info('AI failure summary attached', { jobId: job.id });
    } catch (err) {
      log.warn('AI summary generation failed (rule-based summary kept)', { error: (err as Error).message });
    }
  })();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
