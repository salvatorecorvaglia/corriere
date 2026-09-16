/**
 * Vitest configuration for the browser-environment pass.
 *
 * Runs the whole suite under jsdom to catch code that assumes a DOM-less Node runtime —
 * a second execution context for the same assertions, which is cheap (~3s) and has caught
 * environment assumptions before.
 *
 * What this does NOT prove: jsdom still runs on Node, so `Buffer`, `FinalizationRegistry`
 * and friends remain defined here. Every `typeof Buffer !== 'undefined'` guard in src/
 * therefore takes its *Node* branch in this pass too. The browser fallbacks are only
 * genuinely exercised by tests that delete the global themselves — see
 * `tests/auth.test.ts`, which removes `Buffer` to reach the `btoa` path in `setBasicAuth`.
 * Add a test that way, not by assuming this config supplies a browser.
 *
 * Run with: pnpm run test:browser
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
    },
  },
});
