import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { defineConfig, devices } from "@playwright/test";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required by the MQA load config`);
  return value;
}

const baseURL = required("PLAYWRIGHT_BASE_URL");
const base = new URL(baseURL);
const supabase = new URL(required("NEXT_PUBLIC_SUPABASE_URL"));
const internalSupabase = new URL(required("SUPABASE_INTERNAL_URL"));
const expectedAppId = required("MQA_LOAD_EXPECTED_APP_ID");
const expectedSourceFingerprint = required(
  "MQA_LOAD_EXPECTED_SOURCE_FINGERPRINT",
);
const expectedBuildId = required("MQA_LOAD_EXPECTED_BUILD_ID");
const loadId = required("MQA_LOAD_ID");
const totalRequests = Number(required("MQA_LOAD_TOTAL_REQUESTS"));
const p95SlaMs = Number(required("MQA_LOAD_P95_SLA_MS"));
const maxSlaMs = Number(required("MQA_LOAD_MAX_SLA_MS"));

if (
  process.env.NAILIQ_DISPOSABLE_DB !== "1" ||
  base.origin !== "http://127.0.0.1:3100" ||
  base.pathname !== "/" ||
  base.username !== "" ||
  base.password !== "" ||
  base.port !== "3100" ||
  supabase.origin !== "http://127.0.0.1:54321" ||
  supabase.pathname !== "/" ||
  supabase.username !== "" ||
  supabase.password !== "" ||
  internalSupabase.origin !== "http://127.0.0.1:54321" ||
  internalSupabase.pathname !== "/" ||
  internalSupabase.username !== "" ||
  internalSupabase.password !== ""
) {
  throw new Error(
    "MQA local load config requires 127.0.0.1:3100 and an exclusive disposable local Supabase stack on port 54321",
  );
}
if (process.env.MQA_LOAD_SERVER_MODE !== "production-build") {
  throw new Error("MQA_LOAD_SERVER_MODE must be production-build");
}
if (process.env.VERCEL_DEPLOYMENT_ID !== expectedAppId) {
  throw new Error("VERCEL_DEPLOYMENT_ID must match MQA_LOAD_EXPECTED_APP_ID");
}
if (
  process.env.VERCEL_GIT_COMMIT_SHA?.trim() &&
  process.env.VERCEL_GIT_COMMIT_SHA.trim() !== expectedAppId
) {
  throw new Error("VERCEL_GIT_COMMIT_SHA must be unset or match the expected app id");
}
if (
  loadId !== "MQA-0148" ||
  ![250, 500].includes(totalRequests) ||
  p95SlaMs !== 10_000 ||
  maxSlaMs !== 20_000
) {
  throw new Error(
    "MQA-0148 permits only the 250/500 ramp with fixed p95 10000ms and max 20000ms gates",
  );
}
if (!/^[a-f0-9]{64}$/.test(expectedSourceFingerprint)) {
  throw new Error("MQA_LOAD_EXPECTED_SOURCE_FINGERPRINT must be a SHA-256 hex digest");
}
const currentSourceFingerprint = execFileSync(
  process.execPath,
  ["scripts/security/mqa-source-fingerprint.mjs"],
  { cwd: process.cwd(), encoding: "utf8" },
).trim();
const currentBuildId = readFileSync(".next/BUILD_ID", "utf8").trim();
const derivedAppId =
  `mqa-local-${currentSourceFingerprint.slice(0, 12)}-${currentBuildId}`;
if (
  currentSourceFingerprint !== expectedSourceFingerprint ||
  currentBuildId !== expectedBuildId ||
  expectedAppId !== derivedAppId
) {
  throw new Error(
    "MQA load source fingerprint, .next build id, and expected app id must describe the same fresh artifact",
  );
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "hundred-user-load.spec.ts",
  globalSetup: "./e2e/helpers/globalSetup.ts",
  globalTeardown: "./e2e/helpers/globalTeardown.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 4 * 60_000,
  outputDir: `test-results/mqa-0148-${totalRequests}-${expectedAppId}`,
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile:
          `playwright-report/mqa-load-${totalRequests}-${expectedAppId}.json`,
      },
    ],
  ],
  use: {
    baseURL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command:
      "NEXT_PUBLIC_DEMO_OTP=false DEMO_OTP=false " +
      "SUPABASE_INTERNAL_URL=http://127.0.0.1:54321 " +
      "NAILIQ_TEST_BYPASS_SLUG_PIN=0 DISABLE_OUTBOUND_SMS=1 " +
      "DISABLE_OUTBOUND_CALLS=1 DISABLE_OUTBOUND_EMAIL=1 " +
      "npm run start -- -H 127.0.0.1 -p 3100",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
