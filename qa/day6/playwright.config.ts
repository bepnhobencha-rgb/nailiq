import { defineConfig, devices } from "@playwright/test";
import base from "../day5/playwright.config";

// Importing the shared config enforces local URLs, real Auth and provider OFF.
export default defineConfig({
  ...base,
  testDir: ".", testMatch: ["owner-journey.spec.ts", "client-directory.spec.ts", "loyalty-readonly.spec.ts"],
  globalSetup: "../../e2e/helpers/globalSetup.ts",
  globalTeardown: "../day5/teardown.ts",
  outputDir: "../../test-results/day6-owner",
  reporter: [["list"], ["json", { outputFile: "../../test-results/day6-owner/results.json" }]],
  projects: [
    { name: "se-en", use: { ...devices["iPhone SE"], browserName: "webkit" } },
    { name: "se-vi", use: { ...devices["iPhone SE"], browserName: "webkit" } },
    { name: "max-en", use: { ...devices["iPhone 14 Pro Max"], browserName: "webkit" } },
    { name: "max-vi", use: { ...devices["iPhone 14 Pro Max"], browserName: "webkit" } },
    { name: "ipad-vi", use: { ...devices["iPad (gen 7)"], browserName: "webkit" } },
    { name: "desktop-admin-en", use: { ...devices["Desktop Chrome"] } },
  ],
});
