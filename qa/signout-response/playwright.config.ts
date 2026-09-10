import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "signout.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  reporter: [["list"], ["json", { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME || "test-results/results.json" }]],
  use: { baseURL: "http://127.0.0.1:3120", screenshot: "only-on-failure" },
  projects: [
    { name: "narrow", use: { ...devices["Desktop Chrome"], viewport: { width: 320, height: 720 } } },
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["iPhone 13"], defaultBrowserType: "webkit" } },
  ],
  webServer: {
    command: "node node_modules/next/dist/bin/next start qa/signout-response -H 127.0.0.1 -p 3120",
    cwd: "../..",
    url: "http://127.0.0.1:3120",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
