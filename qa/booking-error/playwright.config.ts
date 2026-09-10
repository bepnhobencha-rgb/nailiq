import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const repositoryRoot = resolve(__dirname, '../..');
const resultsRoot = resolve(repositoryRoot, 'test-results/booking-error');

export default defineConfig({
  expect: { timeout: 2000 },
  testDir: '.',
  testMatch: 'recovery.spec.ts',
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['json', {
      outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME || resolve(resultsRoot, 'results.json'),
    }],
  ],
  outputDir: resolve(resultsRoot, 'artifacts'),
  use: { baseURL: 'http://127.0.0.1:3123', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['iPhone 13'], defaultBrowserType: 'webkit' } },
  ],
  webServer: {
    command: 'node node_modules/next/dist/bin/next start qa/booking-error -H 127.0.0.1 -p 3123',
    cwd: repositoryRoot,
    url: 'http://127.0.0.1:3123',
    reuseExistingServer: process.env.QA_REUSE_SERVER === '1',
  },
});
