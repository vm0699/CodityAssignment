import { describe, expect, it } from 'vitest';
import { createJobSchema, createQueueSchema, parseStatusList, registerSchema } from '../../apps/api/src/validate';

describe('API validation schemas', () => {
  it('accepts a minimal job', () => {
    const parsed = createJobSchema.parse({ type: 'email.send' });
    expect(parsed.type).toBe('email.send');
  });

  it('rejects delayMs and runAt together', () => {
    expect(() =>
      createJobSchema.parse({ type: 'x', delayMs: 1000, runAt: new Date().toISOString() }),
    ).toThrow();
  });

  it('coerces runAt strings to dates', () => {
    const parsed = createJobSchema.parse({ type: 'x', runAt: '2030-01-01T00:00:00Z' });
    expect(parsed.runAt).toBeInstanceOf(Date);
  });

  it('rejects oversized payloads', () => {
    expect(() => createJobSchema.parse({ type: 'x', payload: { blob: 'a'.repeat(70_000) } })).toThrow();
  });

  it('bounds queue concurrency', () => {
    expect(() => createQueueSchema.parse({ name: 'q', maxConcurrency: 0 })).toThrow();
    expect(() => createQueueSchema.parse({ name: 'q', maxConcurrency: 5000 })).toThrow();
    expect(createQueueSchema.parse({ name: 'q', maxConcurrency: 50 }).maxConcurrency).toBe(50);
  });

  it('rejects queue names with spaces', () => {
    expect(() => createQueueSchema.parse({ name: 'bad name' })).toThrow();
  });

  it('enforces password minimum on registration', () => {
    expect(() => registerSchema.parse({ email: 'a@b.co', name: 'A', password: 'short' })).toThrow();
  });

  it('parses comma-separated status lists', () => {
    expect(parseStatusList('queued,running')).toEqual(['queued', 'running']);
    expect(parseStatusList(undefined)).toBeUndefined();
    expect(() => parseStatusList('queued,bogus')).toThrow(/Invalid status/);
  });
});
