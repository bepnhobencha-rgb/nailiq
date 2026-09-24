import { defineConfig, devices } from "@playwright/test";

if (process.env.PLAYWRIGHT_BASE_URL !== "http://127.0.0.1:3117"
  || process.env.NEXT_PUBLIC_SUPABASE_URL !== "http://127.0.0.1:54321"
  || process.env.SUPABASE_INTERNAL_URL !== "http://127.0.0.1:54321"
  || process.env.NAILIQ_DISPOSABLE_DB !== "1"
  || ["DISABLE_OUTBOUND_SMS", "DISABLE_OUTBOUND_EMAIL", "DISABLE_OUTBOUND_CALLS"].some(key => process.env[key] !== "1")
  || process.env.NEXT_PUBLIC_DEMO_OTP !== "false"
  || process.env.DEMO_OTP !== "false") throw new Error("Day 5 requires isolated local QA with providers disabled and real Auth");

export default defineConfig({
  testDir: "../../e2e",
  testMatch: ["receptionist-center/operator-journey.spec.ts", "p0-tenant-auth.spec.ts", "receptionist-center/walkin-response-loss.spec.ts", "receptionist-center/conflict-prevention.spec.ts"],
  globalSetup: "../../e2e/helpers/globalSetup.ts",
  globalTeardown: "./teardown.ts",
  fullyParallel: false, forbidOnly: true, workers: 1, retries: 0,
  timeout: 180_000,
  outputDir: "../../test-results/day5-operator",
  reporter: [["list"], ["json", { outputFile: "../../test-results/day5-operator/results.json" }]],
  use: { baseURL: "http://127.0.0.1:3117", timezoneId: "America/Los_Angeles", actionTimeout: 15_000, navigationTimeout: 45_000, screenshot: "only-on-failure", trace: "off", video: "off" },
  projects: [
    { name: "desktop-en", use: { ...devices["Desktop Chrome"] } },
    { name: "desktop-vi", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-en", use: { ...devices["iPhone 14"], browserName: "webkit" } },
    { name: "mobile-vi", use: { ...devices["iPhone 14"], browserName: "webkit" } },
    { name: "ipad-en", use: { ...devices["iPad (gen 7)"], browserName: "webkit" } },
    { name: "ipad-vi", use: { ...devices["iPad (gen 7)"], browserName: "webkit" } },
  ],
  webServer: {
    command: `"${process.execPath}" node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3117`,
    cwd: "../..", url: "http://127.0.0.1:3117", reuseExistingServer: false, timeout: 60_000,
  },
});
