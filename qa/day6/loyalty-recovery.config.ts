import { defineConfig, devices } from "@playwright/test";
import base from "../day5/playwright.config";

// Reuse the real-Auth, loopback-only, provider-OFF safety boundary.
export default defineConfig({
  ...base,
  testDir: "../../e2e",
  testMatch: ["loyalty-widget-recovery.spec.ts"],
  globalSetup: "../../e2e/helpers/globalSetup.ts",
  globalTeardown: "../day5/teardown.ts",
  outputDir: "../../test-results/day6-loyalty-recovery",
  reporter: [["list"]],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 14"], browserName: "webkit" } },
  ],
});
