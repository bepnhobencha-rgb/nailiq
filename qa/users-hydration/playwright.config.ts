import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "users.spec.ts", workers: 1, retries: 0,
  reporter: [["list"], ["json", { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME || "test-results/users-hydration.json" }]],
  use: { baseURL: "http://127.0.0.1:3122", screenshot: "only-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["iPhone 13"], defaultBrowserType: "webkit" } },
  ],
  webServer: {
    command: "node node_modules/next/dist/bin/next start qa/users-hydration -H 127.0.0.1 -p 3122",
    env: { TZ: "UTC" },
    cwd: "../..", url: "http://127.0.0.1:3122", reuseExistingServer: false,
  },
});
