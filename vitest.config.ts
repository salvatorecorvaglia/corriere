import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // A floor just under the measured baseline (statements 96.0%, branches 90.2%,
      // functions 97.9%, lines 97.1%) — enough to catch a real regression without being
      // brittle to minor fluctuations. Re-baseline in the same commit that moves coverage.
      thresholds: {
        statements: 95,
        branches: 89,
        functions: 97,
        lines: 96,
      },
    },
  },
});
