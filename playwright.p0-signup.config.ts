import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const artifacts = resolve(process.env.NAILIQ_QA_ARTIFACT_DIR ?? "test-results/p0-signup");

export default defineConfig({
  ...base,
  webServer: undefined,
  retries: 0,
  workers: 1,
  testMatch: ["auth-signup-confirmation.spec.ts", "auth-email-callback.spec.ts"],
  outputDir: resolve(artifacts, "browser-artifacts"),
  reporter: [["list"], ["json", { outputFile: resolve(artifacts, "browser-results.json") }]],
  use: { ...base.use, trace: "off", video: "off", screenshot: "off" },
});
