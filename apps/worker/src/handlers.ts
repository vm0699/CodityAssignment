import type { Job, LogLevel } from '@pulse/core';

export interface HandlerContext {
  job: Job;
  /** Structured log line persisted to job_logs and visible in the dashboard. */
  log: (level: LogLevel, message: string, context?: Record<string, unknown>) => Promise<void>;
  /** Fired when the job's timeout elapses or the worker is shutting down hard. */
  signal: AbortSignal;
  /** Stable per-attempt idempotency key handlers can pass to external systems. */
  idempotencyKey: string;
}

export type JobHandler = (payload: Record<string, unknown>, ctx: HandlerContext) => Promise<Record<string, unknown> | void>;

/**
 * Handler registry. Job `type` selects the handler; unknown types fail the
 * job immediately (no retry storm for a typo'd type — it would never succeed).
 */
export const handlers: Record<string, JobHandler> = {
  /** Sleeps payload.ms (bounded). Useful for demos and concurrency tests. */
  'demo.sleep': async (payload, ctx) => {
    const ms = clampNumber(payload.ms, 0, 300_000, 1000);
    await ctx.log('info', `sleeping for ${ms}ms`);
    await interruptibleSleep(ms, ctx.signal);
    return { sleptMs: ms };
  },

  /** Simulated CPU work with progress logs. */
  'demo.compute': async (payload, ctx) => {
    const iterations = clampNumber(payload.iterations, 1, 1000, 25);
    let acc = 0;
    for (let i = 1; i <= iterations; i++) {
      ctx.signal.throwIfAborted();
      // ~20ms of "work" per iteration
      await interruptibleSleep(20, ctx.signal);
      acc += Math.sqrt(i) * 17;
      if (i % Math.max(1, Math.floor(iterations / 4)) === 0) {
        await ctx.log('info', `progress ${i}/${iterations}`, { pct: Math.round((i / iterations) * 100) });
      }
    }
    return { iterations, result: Math.round(acc * 100) / 100 };
  },

  /** Fails with probability payload.failureRate — exercises retry policies and the DLQ. */
  'demo.flaky': async (payload, ctx) => {
    const failureRate = clampNumber(payload.failureRate, 0, 1, 0.5);
    await interruptibleSleep(150, ctx.signal);
    if (Math.random() < failureRate) {
      await ctx.log('warn', `simulated failure (rate=${failureRate})`);
      throw new Error(`Simulated transient failure (failureRate=${failureRate})`);
    }
    await ctx.log('info', 'got lucky, completing');
    return { survivedFailureRate: failureRate };
  },

  /** Always fails — deterministic DLQ demo. */
  'demo.fail': async (payload) => {
    throw new Error(typeof payload.message === 'string' ? payload.message : 'Intentional failure');
  },

  /** Simulated transactional email delivery. */
  'email.send': async (payload, ctx) => {
    const to = typeof payload.to === 'string' ? payload.to : 'unknown@example.com';
    const template = typeof payload.template === 'string' ? payload.template : 'default';
    await ctx.log('info', `rendering template '${template}' for ${to}`);
    await interruptibleSleep(200 + Math.random() * 400, ctx.signal);
    if (!to.includes('@')) throw new Error(`Invalid recipient address: ${to}`);
    await ctx.log('info', `delivered to ${to}`, { messageId: ctx.idempotencyKey });
    return { to, template, messageId: ctx.idempotencyKey };
  },

  /** Real outbound HTTP call with the job timeout enforced via AbortSignal. */
  'http.request': async (payload, ctx) => {
    const url = String(payload.url ?? '');
    if (!/^https?:\/\//.test(url)) throw new Error(`payload.url must be an http(s) URL, got "${url}"`);
    const method = typeof payload.method === 'string' ? payload.method.toUpperCase() : 'GET';
    await ctx.log('info', `${method} ${url}`);
    const response = await fetch(url, {
      method,
      headers: (payload.headers as Record<string, string>) ?? undefined,
      body: payload.body !== undefined ? JSON.stringify(payload.body) : undefined,
      signal: ctx.signal,
    });
    const expect = clampNumber(payload.expectStatus, 100, 599, 0);
    await ctx.log('info', `response ${response.status}`);
    if (expect ? response.status !== expect : response.status >= 500) {
      throw new Error(`Unexpected status ${response.status} from ${url}`);
    }
    return { status: response.status, contentType: response.headers.get('content-type') ?? undefined };
  },
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
