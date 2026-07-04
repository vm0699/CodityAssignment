import { describe, expect, it } from 'vitest';
import { computeBackoffMs } from '@pulse/core';

describe('computeBackoffMs', () => {
  it('fixed strategy returns the base delay for every attempt', () => {
    const policy = { strategy: 'fixed' as const, baseDelayMs: 5000, maxDelayMs: 60_000 };
    expect(computeBackoffMs(policy, 1)).toBe(5000);
    expect(computeBackoffMs(policy, 2)).toBe(5000);
    expect(computeBackoffMs(policy, 10)).toBe(5000);
  });

  it('linear strategy grows proportionally to the attempt number', () => {
    const policy = { strategy: 'linear' as const, baseDelayMs: 1000, maxDelayMs: 60_000 };
    expect(computeBackoffMs(policy, 1)).toBe(1000);
    expect(computeBackoffMs(policy, 2)).toBe(2000);
    expect(computeBackoffMs(policy, 5)).toBe(5000);
  });

  it('exponential strategy doubles per attempt', () => {
    const policy = { strategy: 'exponential' as const, baseDelayMs: 1000, maxDelayMs: 600_000 };
    expect(computeBackoffMs(policy, 1)).toBe(1000);
    expect(computeBackoffMs(policy, 2)).toBe(2000);
    expect(computeBackoffMs(policy, 3)).toBe(4000);
    expect(computeBackoffMs(policy, 4)).toBe(8000);
  });

  it('caps every strategy at maxDelayMs', () => {
    expect(computeBackoffMs({ strategy: 'exponential', baseDelayMs: 1000, maxDelayMs: 10_000 }, 20)).toBe(10_000);
    expect(computeBackoffMs({ strategy: 'linear', baseDelayMs: 1000, maxDelayMs: 3000 }, 50)).toBe(3000);
    expect(computeBackoffMs({ strategy: 'fixed', baseDelayMs: 9000, maxDelayMs: 4000 }, 1)).toBe(4000);
  });

  it('does not overflow on huge attempt numbers', () => {
    const delay = computeBackoffMs({ strategy: 'exponential', baseDelayMs: 1000, maxDelayMs: 60_000 }, 1000);
    expect(delay).toBe(60_000);
  });

  it('jitter reduces the delay by at most jitterFactor', () => {
    const policy = { strategy: 'fixed' as const, baseDelayMs: 10_000, maxDelayMs: 10_000, jitterFactor: 0.3 };
    // rng pinned to extremes
    expect(computeBackoffMs(policy, 1, () => 0)).toBe(10_000);
    expect(computeBackoffMs(policy, 1, () => 1)).toBe(7000);
    for (let i = 0; i < 50; i++) {
      const d = computeBackoffMs(policy, 1);
      expect(d).toBeGreaterThanOrEqual(7000);
      expect(d).toBeLessThanOrEqual(10_000);
    }
  });

  it('rejects attempt < 1', () => {
    expect(() => computeBackoffMs({ strategy: 'fixed', baseDelayMs: 1, maxDelayMs: 1 }, 0)).toThrow();
  });
});
