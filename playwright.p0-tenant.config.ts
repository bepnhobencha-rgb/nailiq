import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const artifacts = resolve(process.env.NAILIQ_QA_ARTIFACT_DIR ?? "test-results/p0-tenant");
export default defineConfig({
  ...base,
  webServer: undefined,
  retries: 0,
  workers: 1,
  testMatch: ["p0-tenant-auth.spec.ts", "receptionist-center/booking-permissions.spec.ts"],
  outputDir: resolve(artifacts, "p0-03-browser-artifacts"),
  reporter: [["list"], ["json", { outputFile: resolve(artifacts, "p0-03-browser-results.json") }]],
  use: { ...base.use, trace: "off", video: "off", screenshot: "off" },
});
