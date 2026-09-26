import { defineConfig } from "@playwright/test";

// Deliberately no dotenv, DB seed, global setup, or hosted base URL.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "management-link-guidance.spec.ts",
  workers: 1,
  retries: 0,
  use: { baseURL: "http://127.0.0.1:3197", viewport: { width: 390, height: 844 }, timezoneId: "UTC" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
