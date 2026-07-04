import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['tests/unit/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.test.ts'],
      environment: 'node',
      // Integration tests share one Postgres database — run files serially.
      fileParallelism: false,
      setupFiles: ['tests/integration/setup-env.ts'],
      globalSetup: 'tests/integration/global-setup.ts',
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  },
]);
