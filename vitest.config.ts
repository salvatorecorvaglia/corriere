import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // A floor just under the measured baseline (statements 91.9%, branches 85.9%,
      // functions 95.2%, lines 93.0%) — enough to catch a real regression without being
      // brittle to minor fluctuations. Re-baseline in the same commit that moves coverage.
      thresholds: {
        statements: 91,
        branches: 84,
        functions: 94,
        lines: 92,
      },
    },
  },
});
