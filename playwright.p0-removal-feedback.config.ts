import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const artifacts = process.env.NAILIQ_QA_ARTIFACT_DIR;
if (!artifacts) throw new Error("Explicit QA artifact directory required");
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3309";
if (!["http://localhost:3309", "https://nailiq-p0-signup-qa-20260911.vercel.app"].includes(baseURL)) {
  throw new Error("Only isolated local or QA Preview allowed");
}
export default defineConfig({
  testDir: "./e2e", testMatch: "p0-removal-feedback.spec.ts", workers: 1, retries: 0,
  timeout: 30_000,
  use: { baseURL, viewport: { width: 390, height: 844 },
    trace: "off", screenshot: "off", video: "off", serviceWorkers: "block" },
  outputDir: resolve(artifacts, "artifacts"),
  reporter: [["list"], ["json", { outputFile: resolve(artifacts, "results.json") }]],
});
