#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "dotenv";
import {
  assertSupabaseStatusMatches,
  readLocalStackIdentity,
  runSupabaseStatus,
} from "./local-supabase-status.mjs";

const root = process.cwd();
const envFile = resolve(root, ".env.test.local");
const localAppUrl = "http://127.0.0.1:3100";
const localSupabaseUrl = "http://127.0.0.1:54321";
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
  "DISABLE_OUTBOUND_EMAIL",
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

let envStat;
try {
  envStat = lstatSync(envFile);
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    throw new Error("REFUSE: .env.test.local is missing");
  }
  throw error;
}
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
for (const key of [
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
]) {
  if (!parsed[key]?.trim()) throw new Error(`REFUSE: ${key} is missing`);
}
if (
  parsed.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/$/, "") !==
  localSupabaseUrl
) {
  throw new Error(
    `REFUSE: .env.test.local NEXT_PUBLIC_SUPABASE_URL must be ${localSupabaseUrl}`,
  );
}

// A loopback URL can still be a tunnel to a hosted project. Obtain URL/key
// identity independently from the local CLI before any build or E2E process.
const localStack = readLocalStackIdentity(root, "MQA-0032 local stack");
const localStatus = runSupabaseStatus(localStack);
assertSupabaseStatusMatches(
  {
    apiUrl: parsed.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: parsed.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    serviceRoleKey: parsed.SUPABASE_SERVICE_ROLE_KEY,
  },
  localStatus,
  "MQA-0032 .env.test.local",
);

// This allowlist is the complete child-process environment. Provider tokens in
// the invoking shell are intentionally not inherited by the build, app, or test.
const cleanEnv = {
  PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  NODE_ENV: "production",
  NEXT_TELEMETRY_DISABLED: "1",
  PLAYWRIGHT_BASE_URL: localAppUrl,
  NEXT_PUBLIC_SITE_URL: localAppUrl,
  NEXT_PUBLIC_SUPABASE_URL: localSupabaseUrl,
  SUPABASE_INTERNAL_URL: localSupabaseUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: parsed.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: parsed.SUPABASE_SERVICE_ROLE_KEY,
  E2E_EXPECTED_LOCAL_SERVICE_ROLE_KEY: localStatus.serviceRoleKey,
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
  const fingerprint = execFileSync(
    process.execPath,
    ["scripts/security/mqa-source-fingerprint.mjs"],
    {
      cwd: root,
      encoding: "utf8",
      env: cleanEnv,
      maxBuffer: 64 * 1024 * 1024,
    },
  ).trim();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error("REFUSE: source fingerprint is not a SHA-256 digest");
  }
  return fingerprint;
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

runNode(
  [
    "./node_modules/@playwright/test/cli.js",
    "test",
    "--config=playwright.mqa-scroll.config.ts",
  ],
  {
    ...cleanEnv,
    MQA_SCROLL_RUN_ID: "MQA-0032",
    MQA_SCROLL_SERVER_MODE: "production-build",
    MQA_SCROLL_EXPECTED_SOURCE_FINGERPRINT: fingerprintBefore,
    MQA_SCROLL_EXPECTED_BUILD_ID: buildId,
    MQA_SCROLL_EXPECTED_APP_ID: appId,
    VERCEL_DEPLOYMENT_ID: appId,
  },
);

process.stdout.write(
  `${JSON.stringify({
    result: "PASS",
    mqaId: "MQA-0032",
    surfaces: ["timeline", "queue"],
    sweepsPerSurface: 3,
    sourceFingerprint: fingerprintBefore,
    buildId,
    appId,
  })}\n`,
);
