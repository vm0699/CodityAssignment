import { describe, expect, it } from 'vitest';
import { canTransition, JOB_TRANSITIONS, sourcesOf, type JobStatus } from '@pulse/core';

describe('job state machine', () => {
  it('allows the happy path: scheduled → queued → claimed → running → completed', () => {
    expect(canTransition('scheduled', 'queued')).toBe(true);
    expect(canTransition('queued', 'claimed')).toBe(true);
    expect(canTransition('claimed', 'running')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
  });

  it('allows the retry loop: running → failed → scheduled → queued', () => {
    expect(canTransition('running', 'failed')).toBe(true);
    expect(canTransition('failed', 'scheduled')).toBe(true);
    expect(canTransition('scheduled', 'queued')).toBe(true);
  });

  it('allows dead-lettering and manual requeue', () => {
    expect(canTransition('failed', 'dead_letter')).toBe(true);
    expect(canTransition('dead_letter', 'queued')).toBe(true);
  });

  it('completed is terminal', () => {
    const statuses = Object.keys(JOB_TRANSITIONS) as JobStatus[];
    for (const to of statuses) {
      expect(canTransition('completed', to)).toBe(false);
    }
  });

  it('forbids nonsensical jumps', () => {
    expect(canTransition('queued', 'running')).toBe(false); // must be claimed first
    expect(canTransition('queued', 'completed')).toBe(false);
    expect(canTransition('scheduled', 'running')).toBe(false);
    expect(canTransition('cancelled', 'completed')).toBe(false);
  });

  it('reaper requeue paths exist for in-flight states', () => {
    expect(canTransition('claimed', 'queued')).toBe(true);
    expect(canTransition('running', 'queued')).toBe(true);
  });

  it('sourcesOf inverts the transition map', () => {
    expect(sourcesOf('dead_letter')).toEqual(['failed']);
    expect(sourcesOf('claimed')).toEqual(['queued']);
  });
});
