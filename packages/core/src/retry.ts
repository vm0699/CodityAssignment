import type { BackoffStrategy } from './types.js';

export interface BackoffInput {
  strategy: BackoffStrategy;
  baseDelayMs: number;
  maxDelayMs: number;
  /** 0..1 — proportion of the delay randomised (full jitter on that share). */
  jitterFactor?: number;
}

/**
 * Delay before retry number `attempt` (1-based: attempt=1 → delay after the
 * first failure).
 *
 *   fixed:        base, base, base, ...
 *   linear:       base, 2*base, 3*base, ...
 *   exponential:  base, 2*base, 4*base, 8*base, ...
 *
 * All strategies cap at maxDelayMs. Jitter subtracts a random share of the
 * delay (AWS-style "equal jitter" lower half) to de-synchronise retry storms.
 */
export function computeBackoffMs(input: BackoffInput, attempt: number, rng: () => number = Math.random): number {
  if (attempt < 1) throw new Error(`attempt must be >= 1, got ${attempt}`);
  const { strategy, baseDelayMs, maxDelayMs } = input;

  let delay: number;
  switch (strategy) {
    case 'fixed':
      delay = baseDelayMs;
      break;
    case 'linear':
      delay = baseDelayMs * attempt;
      break;
    case 'exponential':
      // Cap the exponent so 2^n cannot overflow before Math.min applies.
      delay = baseDelayMs * Math.pow(2, Math.min(attempt - 1, 30));
      break;
  }
  delay = Math.min(delay, maxDelayMs);

  const jitter = input.jitterFactor ?? 0;
  if (jitter > 0) {
    delay = delay - delay * jitter * rng();
  }
  return Math.max(0, Math.round(delay));
}
