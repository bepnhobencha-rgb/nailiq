import { defineConfig, devices } from "@playwright/test";
import base from "../day5/playwright.config";

// Reproduce the CI booking gate with unchanged assertions and no retries.
// Inherit the existing loopback-only, provider-OFF safety boundary.
export default defineConfig({
  ...base,
  testMatch: ["booking.spec.ts"],
  globalTeardown: "../day5/teardown.ts",
  outputDir: "../../test-results/day6-booking-submit-diagnostic",
  reporter: [["list"], ["json", { outputFile: "../../test-results/day6-booking-submit-diagnostic/results.json" }]],
  use: { ...base.use, trace: "retain-on-failure", video: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 14"], browserName: "webkit" } },
  ],
});
