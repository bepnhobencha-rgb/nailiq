import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const resultsRoot = path.resolve(__dirname, "../../test-results/password-reset-form");
export default defineConfig({
  testDir: ".",
  testMatch: "form.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  outputDir: path.join(resultsRoot, "artifacts"),
  reporter: [["list"], ["json", { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME || path.join(resultsRoot, "results.json") }]],
  use: { baseURL: "http://127.0.0.1:3113", screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["iPhone 13"], defaultBrowserType: "webkit" } },
  ],
  webServer: {
    command: "node node_modules/next/dist/bin/next start qa/password-reset-form -H 127.0.0.1 -p 3113",
    cwd: "../..",
    url: "http://127.0.0.1:3113",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
