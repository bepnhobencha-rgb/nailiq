import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
const artifacts = process.env.NAILIQ_QA_ARTIFACT_DIR;
if (!artifacts) throw new Error("A private QA artifact directory is required");
export default defineConfig({
  testDir: "./e2e", testMatch: "p0-otp-locale.spec.ts", timeout: 45_000,
  retries: 0, workers: 1,
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL, trace: "off", video: "off", screenshot: "off" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }, { name: "webkit", use: { browserName: "webkit" } }],
  reporter: [["list"], ["json", { outputFile: resolve(artifacts, "results.json") }]],
  outputDir: resolve(artifacts, "artifacts"),
});
