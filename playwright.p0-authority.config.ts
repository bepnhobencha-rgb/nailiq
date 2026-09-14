import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.p0-tenant.config";
const artifacts = process.env.NAILIQ_QA_ARTIFACT_DIR ?? "test-results/p0-authority";
export default defineConfig({
  ...base,
  maxFailures: 3,
  testMatch: ["p0-management-authority.spec.ts", "superadmin/page-role-boundary.spec.ts", "superadmin/salon-flag-role-boundary.spec.ts"],
  outputDir: resolve(artifacts, "artifacts"),
  reporter: [["list"], ["json", { outputFile: resolve(artifacts, "results.json") }]],
});
