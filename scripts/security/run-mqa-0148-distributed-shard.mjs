#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  chromium,
  expect,
  request as playwrightRequest,
} from "@playwright/test";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredInteger(name) {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function percentileNearestRank(samples, percentile) {
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1] ?? 0;
}

const baseURL = required("PLAYWRIGHT_BASE_URL");
const base = new URL(baseURL);
const candidateSha = required("MQA_LOAD_EXPECTED_APP_ID");
const stage = requiredInteger("MQA_LOAD_TOTAL_REQUESTS");
const shardCount = requiredInteger("MQA_LOAD_SHARD_COUNT");
const shardIndex = requiredInteger("MQA_LOAD_SHARD_INDEX");
const startEpochMs = requiredInteger("MQA_LOAD_START_EPOCH_MS");
const slug = required("MQA_LOAD_SALON_SLUG");
const salonName = required("MQA_LOAD_SALON_NAME");
const email = required("MQA_LOAD_OWNER_EMAIL");
const password = required("MQA_LOAD_OWNER_PASSWORD");
const bypassSecret = required("VERCEL_AUTOMATION_BYPASS_SECRET");
const artifactDirectory = resolve(
  process.cwd(),
  required("MQA_LOAD_ARTIFACT_DIRECTORY"),
);

if (
  base.protocol !== "https:" ||
  !base.hostname.endsWith(".vercel.app") ||
  /(^|\.)nailiq\.vercel\.app$/i.test(base.hostname) ||
  base.pathname !== "/" ||
  !/^[a-f0-9]{40}$/.test(candidateSha) ||
  ![250, 500].includes(stage) ||
  shardCount !== 10 ||
  shardIndex < 0 ||
  shardIndex >= shardCount ||
  slug !== `e2e-mqa-0148-${stage}-distributed-load` ||
  salonName !== `E2E MQA-0148 ${stage} Distributed Load Salon`
) {
  throw new Error("REFUSE: distributed shard identity or QA boundary mismatch");
}

const assignedIndexes = Array.from({ length: stage }, (_, index) => index).filter(
  (index) => index % shardCount === shardIndex,
);
const publicRequests = Math.round(stage * 0.7);
const protectionHeaders = {
  "x-vercel-protection-bypass": bypassSecret,
};

async function verifyVersion() {
  const response = await fetch(`${baseURL}/api/version`, {
    headers: protectionHeaders,
    redirect: "manual",
  });
  if (response.status !== 200) {
    throw new Error(`/api/version returned ${response.status}`);
  }
  const body = await response.json();
  if (body?.id !== candidateSha) {
    throw new Error("Preview identity does not match the exact candidate SHA");
  }
}

async function loginAndCaptureStorageState() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      baseURL,
      extraHTTPHeaders: protectionHeaders,
    });
    const page = await context.newPage();
    await page.goto("/register");
    await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
      "data-hydrated",
      "true",
    );
    await page.locator('input[inputmode="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await page.waitForURL(new RegExp(`/dashboard/${slug}`), { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: salonName })).toBeVisible({
      timeout: 15_000,
    });
    const storageState = await context.storageState();
    await context.close();
    return storageState;
  } finally {
    await browser.close();
  }
}

function writeArtifact(payload) {
  mkdirSync(artifactDirectory, { recursive: true });
  const filename = resolve(
    artifactDirectory,
    `mqa-0148-${stage}-shard-${String(shardIndex).padStart(2, "0")}.json`,
  );
  writeFileSync(filename, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
}

await verifyVersion();
const storageState = await loginAndCaptureStorageState();

const waitMs = startEpochMs - Date.now();
if (waitMs < -20_000 || waitMs > 20 * 60_000) {
  throw new Error("REFUSE: distributed start barrier is stale or too far away");
}
if (waitMs > 0) {
  await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
}

const contexts = await Promise.all(
  assignedIndexes.map((globalIndex) => {
    const kind = globalIndex < publicRequests ? "booking" : "dashboard";
    return playwrightRequest.newContext({
      baseURL,
      ...(kind === "dashboard" ? { storageState } : {}),
      extraHTTPHeaders: {
        ...protectionHeaders,
        accept: "text/html",
      },
    });
  }),
);

const releasedAtMs = Date.now();
let results;
try {
  results = await Promise.all(
    assignedIndexes.map(async (globalIndex, localIndex) => {
      const kind = globalIndex < publicRequests ? "booking" : "dashboard";
      const startedAt = performance.now();
      try {
        const response = await contexts[localIndex].get(
          kind === "booking"
            ? `/${slug}?load_user=${globalIndex}`
            : `/dashboard/${slug}?load_user=${globalIndex}`,
        );
        const body = await response.text();
        return {
          globalIndex,
          kind,
          status: response.status(),
          ok: response.ok(),
          redirectedToLogin:
            response.url().includes("/login") ||
            response.url().includes("/register"),
          correctTenant: body.includes(salonName),
          elapsedMs: Math.round(performance.now() - startedAt),
          error: null,
        };
      } catch (error) {
        return {
          globalIndex,
          kind,
          status: 0,
          ok: false,
          redirectedToLogin: false,
          correctTenant: false,
          elapsedMs: Math.round(performance.now() - startedAt),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
} finally {
  await Promise.all(contexts.map((context) => context.dispose()));
}

const failures = results.filter(
  (result) =>
    !result.ok ||
    result.status !== 200 ||
    result.redirectedToLogin ||
    !result.correctTenant ||
    result.error,
);
const samples = results.map((result) => result.elapsedMs);
const artifact = {
  mqaId: "MQA-0148",
  serverMode: "vercel-preview-distributed",
  githubRunId: process.env.GITHUB_RUN_ID?.trim() ?? null,
  githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT?.trim() ?? null,
  candidateSha,
  stage,
  shardCount,
  shardIndex,
  startEpochMs,
  releasedAtMs,
  releaseSkewMs: releasedAtMs - startEpochMs,
  assignedIndexes,
  summary: {
    requests: results.length,
    failures: failures.length,
    p95Ms: percentileNearestRank(samples, 0.95),
    maxMs: Math.max(...samples),
  },
  results,
};
writeArtifact(artifact);
process.stdout.write(
  `[MQA-0148-SHARD] ${JSON.stringify({
    stage,
    shardIndex,
    ...artifact.summary,
    releaseSkewMs: artifact.releaseSkewMs,
  })}\n`,
);
if (failures.length > 0) process.exitCode = 1;
