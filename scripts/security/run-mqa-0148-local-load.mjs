#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "dotenv";

const root = process.cwd();
const envFile = resolve(root, ".env.test.local");
const forbiddenNextEnvFiles = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
];
const allowedFileKeys = new Set([
  "AI_PREFILL_E2E_MOCK",
  "CRON_SECRET",
  "DEMO_OTP",
  "DISABLE_OUTBOUND_CALLS",
  "DISABLE_OUTBOUND_SMS",
  "INTERNAL_API_SECRET",
  "NAILIQ_TEST_BYPASS_SLUG_PIN",
  "NEXT_PUBLIC_DEMO_OTP",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "PLAYWRIGHT_BASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
]);

for (const filename of forbiddenNextEnvFiles) {
  try {
    statSync(resolve(root, filename));
    throw new Error(`REFUSE: Next could auto-load ${filename}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      continue;
    }
    throw error;
  }
}

const envStat = lstatSync(envFile);
if (!envStat.isFile() || envStat.isSymbolicLink()) {
  throw new Error("REFUSE: .env.test.local must be a regular non-symlink file");
}
if ((envStat.mode & 0o077) !== 0) {
  throw new Error("REFUSE: .env.test.local permissions must be 0600");
}

const parsed = parse(readFileSync(envFile));
const unexpectedKeys = Object.keys(parsed).filter(
  (key) => !allowedFileKeys.has(key),
);
if (unexpectedKeys.length > 0) {
  throw new Error(
    `REFUSE: .env.test.local contains non-allowlisted keys: ${unexpectedKeys.join(", ")}`,
  );
}

const localUrl = "http://127.0.0.1:54321";
for (const key of [
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
]) {
  if (!parsed[key]?.trim()) throw new Error(`REFUSE: ${key} is missing`);
}
if (parsed.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "") !== localUrl) {
  throw new Error("REFUSE: .env.test.local Supabase URL is not exact loopback");
}

const cleanEnv = {
  PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  NODE_ENV: "production",
  NEXT_TELEMETRY_DISABLED: "1",
  PLAYWRIGHT_BASE_URL: "http://127.0.0.1:3100",
  NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3100",
  NEXT_PUBLIC_SUPABASE_URL: localUrl,
  SUPABASE_INTERNAL_URL: localUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: parsed.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: parsed.SUPABASE_SERVICE_ROLE_KEY,
  CRON_SECRET: parsed.CRON_SECRET ?? "",
  INTERNAL_API_SECRET: parsed.INTERNAL_API_SECRET ?? "",
  NEXT_PUBLIC_DEMO_OTP: "false",
  DEMO_OTP: "false",
  NAILIQ_TEST_BYPASS_SLUG_PIN: "0",
  AI_PREFILL_E2E_MOCK: "services",
  DISABLE_OUTBOUND_SMS: "1",
  DISABLE_OUTBOUND_CALLS: "1",
  DISABLE_OUTBOUND_EMAIL: "1",
  NAILIQ_DISPOSABLE_DB: "1",
};

function sourceFingerprint() {
  return execFileSync(
    process.execPath,
    ["scripts/security/mqa-source-fingerprint.mjs"],
    { cwd: root, encoding: "utf8" },
  ).trim();
}

function runNode(args, env = cleanEnv) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`command failed with exit ${result.status}: node ${args[0]}`);
  }
}

const fingerprintBefore = sourceFingerprint();
runNode(["./node_modules/next/dist/bin/next", "build"]);
const fingerprintAfter = sourceFingerprint();
if (fingerprintAfter !== fingerprintBefore) {
  throw new Error("REFUSE: source changed while the production build was running");
}

const buildId = readFileSync(resolve(root, ".next/BUILD_ID"), "utf8").trim();
if (!/^[A-Za-z0-9_-]+$/.test(buildId)) {
  throw new Error("REFUSE: invalid .next/BUILD_ID");
}
const appId = `mqa-local-${fingerprintBefore.slice(0, 12)}-${buildId}`;

for (const stage of [250, 500]) {
  runNode(
    [
      "./node_modules/@playwright/test/cli.js",
      "test",
      "--config=playwright.mqa-load.config.ts",
    ],
    {
      ...cleanEnv,
      MQA_LOAD_ID: "MQA-0148",
      MQA_LOAD_TOTAL_REQUESTS: String(stage),
      MQA_LOAD_P95_SLA_MS: "10000",
      MQA_LOAD_MAX_SLA_MS: "20000",
      MQA_LOAD_SERVER_MODE: "production-build",
      MQA_LOAD_EXPECTED_SOURCE_FINGERPRINT: fingerprintBefore,
      MQA_LOAD_EXPECTED_BUILD_ID: buildId,
      MQA_LOAD_EXPECTED_APP_ID: appId,
      VERCEL_DEPLOYMENT_ID: appId,
    },
  );
}

process.stdout.write(
  `${JSON.stringify({
    result: "PASS",
    mqaId: "MQA-0148",
    stages: [250, 500],
    sourceFingerprint: fingerprintBefore,
    buildId,
    appId,
  })}\n`,
);
