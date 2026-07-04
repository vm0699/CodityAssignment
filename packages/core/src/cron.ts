import cronParser from 'cron-parser';

/** Throws with a friendly message if the expression or timezone is invalid. */
export function validateCron(expression: string, timezone = 'UTC'): void {
  // cron-parser silently tolerates unknown timezones — validate explicitly.
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new Error(`Invalid cron timezone "${timezone}"`);
  }
  try {
    cronParser.parseExpression(expression, { tz: timezone });
  } catch (err) {
    throw new Error(`Invalid cron expression "${expression}": ${(err as Error).message}`);
  }
}

/** Next occurrence strictly after `after` in the schedule's timezone. */
export function nextCronOccurrence(expression: string, timezone = 'UTC', after: Date = new Date()): Date {
  const interval = cronParser.parseExpression(expression, { tz: timezone, currentDate: after });
  return interval.next().toDate();
}

/** Human-friendly hint for a handful of common expressions (dashboard UX). */
export function describeCron(expression: string): string {
  const known: Record<string, string> = {
    '* * * * *': 'every minute',
    '*/5 * * * *': 'every 5 minutes',
    '0 * * * *': 'hourly',
    '0 0 * * *': 'daily at midnight',
    '0 9 * * 1-5': 'weekdays at 09:00',
    '0 0 * * 0': 'weekly on Sunday',
    '0 0 1 * *': 'monthly on the 1st',
  };
  return known[expression.trim()] ?? expression;
}
