import { describe, expect, it } from 'vitest';
import { describeCron, nextCronOccurrence, validateCron } from '@pulse/core';

describe('cron utilities', () => {
  it('accepts valid expressions', () => {
    expect(() => validateCron('* * * * *')).not.toThrow();
    expect(() => validateCron('0 9 * * 1-5')).not.toThrow();
    expect(() => validateCron('*/15 2,14 1 * *')).not.toThrow();
  });

  it('rejects invalid expressions with a friendly message', () => {
    expect(() => validateCron('not a cron')).toThrow(/Invalid cron expression/);
    expect(() => validateCron('99 * * * *')).toThrow(/Invalid cron expression/);
  });

  it('rejects invalid timezones', () => {
    expect(() => validateCron('* * * * *', 'Mars/Olympus')).toThrow(/Invalid cron timezone/);
  });

  it('computes the next occurrence strictly after the reference time', () => {
    const after = new Date('2026-07-04T10:30:00Z');
    const next = nextCronOccurrence('0 * * * *', 'UTC', after);
    expect(next.toISOString()).toBe('2026-07-04T11:00:00.000Z');
  });

  it('computes minutely schedules', () => {
    const after = new Date('2026-07-04T10:30:10Z');
    const next = nextCronOccurrence('* * * * *', 'UTC', after);
    expect(next.toISOString()).toBe('2026-07-04T10:31:00.000Z');
  });

  it('honours timezones', () => {
    // 09:00 in Kolkata (UTC+5:30) is 03:30 UTC.
    const after = new Date('2026-07-04T00:00:00Z');
    const next = nextCronOccurrence('0 9 * * *', 'Asia/Kolkata', after);
    expect(next.toISOString()).toBe('2026-07-04T03:30:00.000Z');
  });

  it('describes common expressions', () => {
    expect(describeCron('* * * * *')).toBe('every minute');
    expect(describeCron('7 3 * * 2')).toBe('7 3 * * 2'); // unknown → raw
  });
});
