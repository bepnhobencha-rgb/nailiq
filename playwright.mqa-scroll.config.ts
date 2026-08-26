import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { defineConfig, devices } from "@playwright/test";

const LOCAL_APP_ORIGIN = "http://127.0.0.1:3100";
const LOCAL_SUPABASE_ORIGIN = "http://127.0.0.1:54321";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required by the MQA scroll config`);
  return value;
}

function exactLoopbackUrl(name: string, expectedOrigin: string): string {
  const raw = required(name);
  const parsed = new URL(raw);
  if (
    parsed.origin !== expectedOrigin ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error(`${name} must be exactly ${expectedOrigin}`);
  }
  return expectedOrigin;
}

const baseURL = exactLoopbackUrl("PLAYWRIGHT_BASE_URL", LOCAL_APP_ORIGIN);
exactLoopbackUrl("NEXT_PUBLIC_SUPABASE_URL", LOCAL_SUPABASE_ORIGIN);
exactLoopbackUrl("SUPABASE_INTERNAL_URL", LOCAL_SUPABASE_ORIGIN);

const expectedAppId = required("MQA_SCROLL_EXPECTED_APP_ID");
const expectedSourceFingerprint = required(
  "MQA_SCROLL_EXPECTED_SOURCE_FINGERPRINT",
);
const expectedBuildId = required("MQA_SCROLL_EXPECTED_BUILD_ID");

if (
  process.env.MQA_SCROLL_RUN_ID !== "MQA-0032" ||
  process.env.MQA_SCROLL_SERVER_MODE !== "production-build" ||
  process.env.NAILIQ_DISPOSABLE_DB !== "1"
) {
  throw new Error(
    "MQA-0032 requires its dedicated production-build runner and an exclusive disposable local database",
  );
}
if (
  process.env.DISABLE_OUTBOUND_SMS !== "1" ||
  process.env.DISABLE_OUTBOUND_CALLS !== "1" ||
  process.env.DISABLE_OUTBOUND_EMAIL !== "1"
) {
  throw new Error("MQA-0032 requires every outbound messaging channel disabled");
}
if (process.env.VERCEL_DEPLOYMENT_ID !== expectedAppId) {
  throw new Error("VERCEL_DEPLOYMENT_ID must match MQA_SCROLL_EXPECTED_APP_ID");
}
if (
  process.env.VERCEL_GIT_COMMIT_SHA?.trim() &&
  process.env.VERCEL_GIT_COMMIT_SHA.trim() !== expectedAppId
) {
  throw new Error(
    "VERCEL_GIT_COMMIT_SHA must be unset or match the expected local app id",
  );
}
if (!/^[a-f0-9]{64}$/.test(expectedSourceFingerprint)) {
  throw new Error(
    "MQA_SCROLL_EXPECTED_SOURCE_FINGERPRINT must be a SHA-256 hex digest",
  );
}
if (!/^[A-Za-z0-9_-]+$/.test(expectedBuildId)) {
  throw new Error("MQA_SCROLL_EXPECTED_BUILD_ID is invalid");
}

const forbiddenProviderKeyPatterns = [
  /^TWILIO_/,
  /^SQUARE_/,
  /^STRIPE_/,
  /^RESEND_/,
  /^SENDGRID_/,
  /^POSTMARK_/,
  /^MAILGUN_/,
  /^OPENAI_API_KEY$/,
  /^ANTHROPIC_API_KEY$/,
  /^GEMINI_API_KEY$/,
  /^GOOGLE_GENERATIVE_AI_API_KEY$/,
] as const;
const presentProviderKeys = Object.keys(process.env)
  .filter((name) =>
    forbiddenProviderKeyPatterns.some((pattern) => pattern.test(name)),
  )
  .filter((name) => Boolean(process.env[name]?.trim()))
  .sort();
if (presentProviderKeys.length > 0) {
  throw new Error(
    `MQA-0032 refuses provider-configured environments: ${presentProviderKeys.join(", ")}`,
  );
}

const currentSourceFingerprint = execFileSync(
  process.execPath,
  ["scripts/security/mqa-source-fingerprint.mjs"],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  },
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
    "MQA-0032 source fingerprint, .next build id, and expected app id must describe the same fresh artifact",
  );
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "receptionist-center/smooth-scroll-performance.spec.ts",
  globalSetup: "./e2e/helpers/globalSetup.ts",
  globalTeardown: "./e2e/helpers/globalTeardown.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 6 * 60_000,
  expect: { timeout: 15_000 },
  outputDir: `test-results/mqa-0032-${expectedAppId}`,
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: `playwright-report/mqa-0032-${expectedAppId}.json`,
      },
    ],
  ],
  use: {
    baseURL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "off",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
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
