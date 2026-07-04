/**
 * Runs before every integration test file: points DATABASE_URL at the
 * throwaway test database so tests can never touch dev data.
 */
import { loadEnv } from '@pulse/core';

loadEnv();
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://pulse:pulse@localhost:5433/pulse_test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';
process.env.RATE_LIMIT_PER_MINUTE = '100000';
process.env.LOG_LEVEL = 'error';
