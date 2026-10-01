import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const repositoryRoot = resolve(__dirname, "../..");
const resultsRoot = resolve(repositoryRoot, "test-results/waitlist-claim");

export default defineConfig({
  testDir: "./tests",
  testMatch: "claim-recovery.spec.ts",
  retries: 0,
  workers: 1,
  forbidOnly: true,
  reporter: [["list"], ["json", { outputFile: resolve(resultsRoot, "results.json") }]],
  outputDir: resolve(resultsRoot, "artifacts"),
  use: { baseURL: "http://127.0.0.1:3116", trace: "retain-on-failure" },
  projects: [
    { name: "chromium-desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit-se", use: { ...devices["iPhone SE"], browserName: "webkit" } },
    { name: "webkit-pro-max", use: { ...devices["iPhone 14 Pro Max"], browserName: "webkit" } },
    { name: "webkit-ipad", use: { ...devices["iPad (gen 7)"], browserName: "webkit" } },
  ],
  webServer: {
    command: `"${process.execPath}" node_modules/next/dist/bin/next start qa/waitlist-delivery -H 127.0.0.1 -p 3116`,
    cwd: repositoryRoot,
    url: "http://127.0.0.1:3116/claim",
    reuseExistingServer: false,
  },
});
