import { defineConfig } from '@playwright/test';

const port = Number(process.env.CORRIERE_BROWSER_PORT || 4179);
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  timeout: 15_000,
  reporter: 'list',
  outputDir: 'test-results',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: 'node tests/browser/server.mjs',
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 1000 },
  },
});
