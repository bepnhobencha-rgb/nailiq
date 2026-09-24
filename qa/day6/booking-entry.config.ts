import { defineConfig, devices } from "@playwright/test";
import base from "../day5/playwright.config";

// Keep the existing loopback-only, real-Auth, provider-OFF safety boundary.
export default defineConfig({
  ...base,
  testMatch: ["booking-errors.spec.ts", "booking-validation.spec.ts"],
  globalTeardown: "../day5/teardown.ts",
  outputDir: "../../test-results/day6-booking-entry",
  reporter: [["list"]],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 14"], browserName: "webkit" } },
  ],
});
