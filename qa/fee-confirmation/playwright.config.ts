import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "confirmation.spec.ts", workers: 1, retries: 0, timeout: 30000,
  outputDir: "../../test-results/fee-confirmation",
  reporter: [["list"], ["json", { outputFile: "../../test-results/fee-confirmation.json" }]],
  use: { baseURL: "http://127.0.0.1:3128", screenshot: "only-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["iPhone 13"], defaultBrowserType: "webkit" } },
  ],
  webServer: { command: "node node_modules/next/dist/bin/next start qa/fee-confirmation -H 127.0.0.1 -p 3128", cwd: "../..", url: "http://127.0.0.1:3128", reuseExistingServer: false, timeout: 60000 },
});
