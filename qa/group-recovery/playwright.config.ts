import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "recovery.spec.ts", workers: 1, retries: 0, timeout: 30000,
  outputDir: "../../test-results/group-recovery",
  reporter: [["list"], ["json", { outputFile: "../../test-results/group-recovery.json" }]],
  use: { baseURL: "http://127.0.0.1:3129", screenshot: "only-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["iPhone 13"], defaultBrowserType: "webkit" } },
  ],
  webServer: { command: "node node_modules/next/dist/bin/next start qa/group-recovery -H 127.0.0.1 -p 3129", cwd: "../..", url: "http://127.0.0.1:3129", reuseExistingServer: false, timeout: 60000 },
});
