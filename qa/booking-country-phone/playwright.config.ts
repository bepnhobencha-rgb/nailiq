import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
  testDir: "./tests",
  retries: 0,
  workers: 1,
  forbidOnly: true,
  reporter: [["list"], ["json", { outputFile: process.env.COUNTRY_PHONE_RESULTS ?? "test-results/country-phone-results.json" }]],
  outputDir: process.env.COUNTRY_PHONE_OUTPUT ?? "test-results/country-phone",
  use: { baseURL: "http://localhost:3115", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["iPhone 14"], browserName: "webkit" } },
  ],
  // External mode is only for an already-started local fixture (including the
  // Linux container proxy). The test URL cannot be redirected to Production.
  webServer: process.env.COUNTRY_PHONE_EXTERNAL_SERVER === "1" ? undefined : {
    command: `"${process.execPath}" node_modules/next/dist/bin/next start qa/booking-country-phone -H 127.0.0.1 -p 3115`,
    cwd: resolve(__dirname, "../.."),
    url: "http://localhost:3115",
    reuseExistingServer: false,
  },
});
