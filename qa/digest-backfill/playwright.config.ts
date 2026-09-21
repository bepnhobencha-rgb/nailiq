import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
const root = resolve(__dirname, "../..");
export default defineConfig({
  testDir: "./tests", workers: 1, retries: 0, forbidOnly: true,
  reporter: "list", outputDir: resolve(root, "test-results/digest-backfill"),
  use: { baseURL: "http://127.0.0.1:3128", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["iPhone 14"], browserName: "webkit" } },
  ],
  webServer: { command: `"${process.execPath}" node_modules/next/dist/bin/next start qa/digest-backfill -H 127.0.0.1 -p 3128`,
    cwd: root, url: "http://127.0.0.1:3128", reuseExistingServer: false },
});
