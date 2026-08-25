#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createClient } from "@supabase/supabase-js";
import { parse } from "dotenv";

const root = process.cwd();
const branch = "qa/master-checklist-preview-20260822";
const qaProjectRef = "gpwlkggwiyarpacnuixl";
const productionProjectRef = "fshmobzyjhmtvndobwsy";
const vercelProjectId = "prj_1yP37n3CAzbk5BaXizY5TWcOa7gV";
const qaSupabaseUrl = `https://${qaProjectRef}.supabase.co`;
const workflow = "e2e.yml";
const githubSecrets = [
  "MQA0148_QA_OWNER_EMAIL",
  "MQA0148_QA_OWNER_PASSWORD",
  "MQA0148_VERCEL_BYPASS_SECRET",
];
const evidenceDirectory =
  "/Users/huytran/.codex/checkpoints/nailiq-20260820-183925/evidence";

function commandJson(file, args) {
  return JSON.parse(
    execFileSync(file, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 30 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "inherit"],
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${file} ${args.join(" ")} exited ${result.status}`);
  }
  return result;
}

function setGithubSecret(name, value) {
  const result = spawnSync("gh", ["secret", "set", name], {
    cwd: root,
    encoding: "utf8",
    input: value,
    stdio: ["pipe", "ignore", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`failed to set GitHub secret ${name}`);
}

function deleteGithubSecrets() {
  for (const name of githubSecrets) {
    run("gh", ["secret", "delete", name], { allowFailure: true });
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function pullBranchEnv() {
  const directory = mkdtempSync(join(tmpdir(), "nailiq-mqa-0148-vercel-env-"));
  const filename = join(directory, ".env.preview");
  try {
    execFileSync(
      "npx",
      [
        "vercel",
        "env",
        "pull",
        filename,
        "--environment=preview",
        `--git-branch=${branch}`,
        "--yes",
      ],
      { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
    );
    return parse(readFileSync(filename));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function assertVersion(baseURL, bypassSecret, candidateSha) {
  const response = await fetch(`${baseURL}/api/version`, {
    headers: { "x-vercel-protection-bypass": bypassSecret },
    redirect: "manual",
  });
  if (response.status !== 200) {
    throw new Error(`Preview /api/version returned ${response.status}`);
  }
  const body = await response.json();
  if (body?.id !== candidateSha) {
    throw new Error("Preview identity does not match exact candidate SHA");
  }
}

async function assertQaServiceKey(serviceRoleKey) {
  if (!serviceRoleKey) {
    throw new Error("REFUSE: Preview Supabase service key is missing");
  }
  const response = await fetch(`${qaSupabaseUrl}/auth/v1/admin/users?page=1&per_page=1`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  if (response.status !== 200) {
    throw new Error("REFUSE: Preview Supabase service key is not valid for the QA project");
  }
}

async function deleteQaRateLimits(db) {
  for (const prefix of [
    "public-edge:booking-page:",
    "public-edge:auth:",
    "public:auth-password-signin:",
  ]) {
    const { error } = await db.from("rate_limits").delete().like("bucket", `${prefix}%`);
    if (error) throw new Error(`QA limiter cleanup failed: ${error.message}`);
  }
}

async function readQaRateLimits(db, prefix) {
  const rows = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db
      .from("rate_limits")
      .select("bucket, count, expires_at")
      .like("bucket", `${prefix}%`)
      .order("bucket")
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`QA limiter read failed: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < pageSize) return rows;
  }
}

async function sourceProof(db, stage) {
  const rows = await readQaRateLimits(db, "public-edge:booking-page:");
  const minute = rows.filter((row) => row.bucket.startsWith("public-edge:booking-page:minute:"));
  const hour = rows.filter((row) => row.bucket.startsWith("public-edge:booking-page:hour:"));
  const expectedPublic = Math.round(stage * 0.7);
  const proof = {
    expectedMinimumDistinctSources: 10,
    observedMinuteRows: minute.length,
    observedHourRows: hour.length,
    minuteCountTotal: minute.reduce((sum, row) => sum + Number(row.count), 0),
    hourCountTotal: hour.reduce((sum, row) => sum + Number(row.count), 0),
  };
  if (
    proof.observedMinuteRows < 10 ||
    proof.observedHourRows < 10 ||
    proof.minuteCountTotal !== expectedPublic ||
    proof.hourCountTotal !== expectedPublic
  ) {
    throw new Error(`distributed source proof failed: ${JSON.stringify(proof)}`);
  }
  return proof;
}

function triggerWorkflow({ candidateSha, baseURL, stage }) {
  const startEpochMs = Date.now() + 12 * 60_000;
  const triggeredAfter = Date.now() - 5_000;
  run("gh", [
    "workflow",
    "run",
    workflow,
    "--ref",
    branch,
    "-f",
    `candidate_sha=${candidateSha}`,
    "-f",
    `preview_url=${baseURL}`,
    "-f",
    `stage=${stage}`,
    "-f",
    `start_epoch_ms=${startEpochMs}`,
  ]);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const runs = commandJson("gh", [
      "run",
      "list",
      "--workflow",
      workflow,
      "--branch",
      branch,
      "--event",
      "workflow_dispatch",
      "--limit",
      "20",
      "--json",
      "databaseId,headSha,createdAt,status,conclusion",
    ]);
    const match = runs
      .filter(
        (item) =>
          item.headSha === candidateSha &&
          Date.parse(item.createdAt) >= triggeredAfter,
      )
      .sort((left, right) => right.databaseId - left.databaseId)[0];
    if (match) return { runId: match.databaseId, startEpochMs };
    sleep(2_000);
  }
  throw new Error("GitHub Actions run did not appear after dispatch");
}

async function seedRepresentativeVolume(db, salonId) {
  const [{ data: service, error: serviceError }, { data: staff, error: staffError }] =
    await Promise.all([
      db.from("services").select("id, price_cents").eq("salon_id", salonId).single(),
      db.from("staff").select("id").eq("salon_id", salonId).single(),
    ]);
  if (serviceError || staffError || !service?.id || !staff?.id) {
    throw new Error("distributed fixture service/staff lookup failed");
  }
  const nowMs = Date.now();
  const rows = Array.from({ length: 250 }, (_, index) => {
    const startMs = nowMs - (index + 1) * 60 * 60 * 1_000;
    return {
      salon_id: salonId,
      service_id: service.id,
      staff_id: staff.id,
      client_name: `Load Guest ${String(index + 1).padStart(3, "0")}`,
      client_phone: null,
      client_notes: null,
      start_time_utc: new Date(startMs).toISOString(),
      end_time_utc: new Date(startMs + 45 * 60 * 1_000).toISOString(),
      status: "completed",
      source: "appointment",
      price_cents: Number(service.price_cents),
    };
  });
  const { error } = await db.from("bookings").insert(rows);
  if (error) throw new Error(`distributed fixture volume failed: ${error.message}`);
}

const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (!/^[a-f0-9]{40}$/.test(candidateSha)) throw new Error("REFUSE: invalid HEAD SHA");
const currentBranch = execFileSync("git", ["branch", "--show-current"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (currentBranch !== branch) throw new Error("REFUSE: wrong QA branch");

const branchesResponse = commandJson("npx", [
  "supabase",
  "branches",
  "list",
  "--project-ref",
  productionProjectRef,
  "--output-format",
  "json",
]);
const branches = Array.isArray(branchesResponse)
  ? branchesResponse
  : branchesResponse.branches;
const qaBranch = branches?.find((item) => item.project_ref === qaProjectRef);
if (
  !qaBranch ||
  qaBranch.name !== "qa-master-checklist-preview-20260822" ||
  qaBranch.preview_project_status !== "ACTIVE_HEALTHY" ||
  qaBranch.with_data !== false
) {
  throw new Error("REFUSE: Supabase QA branch is not isolated and healthy");
}

const keysResponse = commandJson("npx", [
  "supabase",
  "projects",
  "api-keys",
  "--project-ref",
  qaProjectRef,
  "--reveal",
  "--output-format",
  "json",
]);
const keys = Array.isArray(keysResponse) ? keysResponse : keysResponse.keys;
const publishableKey = String(
  keys?.find(
    (item) =>
      item.name === "nailiq_vercel_preview_qa_20260823" &&
      item.type === "publishable",
  )?.api_key ?? "",
).trim();
const serviceKey = String(
  keys?.find(
    (item) =>
      item.name === "nailiq_vercel_preview_qa_20260823" && item.type === "secret",
  )?.api_key ?? "",
).trim();
if (!publishableKey.startsWith("sb_publishable_") || !serviceKey.startsWith("sb_secret_")) {
  throw new Error("REFUSE: dedicated Supabase QA API keys are missing");
}

const branchEnv = pullBranchEnv();
for (const [key, expected] of [
  ["DISABLE_OUTBOUND_SMS", "1"],
  ["DISABLE_OUTBOUND_EMAIL", "1"],
  ["DISABLE_OUTBOUND_CALLS", "1"],
  ["NAILIQ_DISPOSABLE_DB", "1"],
  ["E2E_EXPECTED_PROJECT_REF", qaProjectRef],
  ["NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF", qaProjectRef],
  ["NEXT_PUBLIC_SUPABASE_URL", qaSupabaseUrl],
  ["NEXT_PUBLIC_SUPABASE_ANON_KEY", publishableKey],
]) {
  const actual = branchEnv[key]?.trim();
  const matches = key.endsWith("_URL")
    ? (() => {
        try {
          return new URL(actual).origin === new URL(expected).origin;
        } catch {
          return false;
        }
      })()
    : actual === expected;
  if (!matches) {
    throw new Error(`REFUSE: exact Preview branch env ${key} is not safely pinned`);
  }
}
await assertQaServiceKey(branchEnv.SUPABASE_SERVICE_ROLE_KEY?.trim());
if (
  branchEnv.SUPABASE_INTERNAL_URL &&
  new URL(branchEnv.SUPABASE_INTERNAL_URL).origin !== qaSupabaseUrl
) {
  throw new Error("REFUSE: Preview SUPABASE_INTERNAL_URL points outside QA");
}

const project = commandJson("npx", ["vercel", "api", `/v9/projects/${vercelProjectId}`]);
const bypassSecrets = Object.keys(project.protectionBypass ?? {});
if (bypassSecrets.length !== 1) {
  throw new Error("REFUSE: expected exactly one temporary Vercel bypass secret");
}
const bypassSecret = bypassSecrets[0];

const deployments = commandJson("npx", [
  "vercel",
  "ls",
  "nailiq",
  "--status",
  "READY",
  "--format=json",
  "--meta",
  `githubCommitSha=${candidateSha}`,
]);
if (!Array.isArray(deployments.deployments) || deployments.deployments.length !== 1) {
  throw new Error("REFUSE: expected one READY exact-SHA Vercel deployment");
}
const deployment = deployments.deployments[0];
if (
  deployment.meta?.githubCommitRef !== branch ||
  deployment.target !== null ||
  deployment.state !== "READY"
) {
  throw new Error("REFUSE: exact deployment is not the isolated Preview branch");
}
const baseURL = `https://${deployment.url}`;
await assertVersion(baseURL, bypassSecret, candidateSha);

Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: qaSupabaseUrl,
  SUPABASE_INTERNAL_URL: qaSupabaseUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: publishableKey,
  SUPABASE_SERVICE_ROLE_KEY: serviceKey,
  E2E_EXPECTED_PROJECT_REF: qaProjectRef,
  NAILIQ_DISPOSABLE_DB: "1",
  DISABLE_OUTBOUND_SMS: "1",
  DISABLE_OUTBOUND_EMAIL: "1",
  DISABLE_OUTBOUND_CALLS: "1",
  NEXT_PUBLIC_DEMO_OTP: "false",
  DEMO_OTP: "false",
  NAILIQ_TEST_BYPASS_SLUG_PIN: "0",
});
const { cleanupTestSalon, cleanupTestUser, seedTestSalon, seedTestSalonMember } =
  await import("../../e2e/helpers/db.ts");
const db = createClient(qaSupabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const temporaryDirectory = mkdtempSync(join(tmpdir(), "nailiq-mqa-0148-distributed-"));
const receipts = [];
let activeFixture;

try {
  await deleteQaRateLimits(db);
  setGithubSecret("MQA0148_VERCEL_BYPASS_SECRET", bypassSecret);

  for (const stage of [250, 500]) {
    const slug = `e2e-mqa-0148-${stage}-distributed-load`;
    const salonName = `E2E MQA-0148 ${stage} Distributed Load Salon`;
    const salon = await seedTestSalon({
      slug,
      name: salonName,
      phone: `1555333${stage}`,
    });
    await seedRepresentativeVolume(db, salon.salonId);
    const owner = await seedTestSalonMember(salon.salonId, "owner");
    activeFixture = { slug, ownerUserId: owner.userId };
    setGithubSecret("MQA0148_QA_OWNER_EMAIL", owner.email);
    setGithubSecret("MQA0148_QA_OWNER_PASSWORD", owner.password);

    const { runId, startEpochMs } = triggerWorkflow({
      candidateSha,
      baseURL,
      stage,
    });
    process.stdout.write(
      `[MQA-0148-DISPATCH] ${JSON.stringify({ stage, runId, startEpochMs })}\n`,
    );
    const watch = run("gh", ["run", "watch", String(runId), "--exit-status"], {
      inherit: true,
      allowFailure: true,
    });
    const artifactDirectory = join(temporaryDirectory, String(stage));
    run("gh", ["run", "download", String(runId), "--dir", artifactDirectory]);
    const receiptFile = join(temporaryDirectory, `mqa-0148-${stage}.json`);
    const aggregate = run(
      process.execPath,
      [
        "scripts/security/aggregate-mqa-0148-distributed.mjs",
        artifactDirectory,
        String(stage),
        candidateSha,
        receiptFile,
      ],
      { allowFailure: true },
    );
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    receipt.githubConclusion = watch.status === 0 ? "success" : "failure";
    receipt.sourceProof = await sourceProof(db, stage);

    await cleanupTestSalon(slug, { clearAllRateLimits: false });
    await cleanupTestUser(owner.userId);
    activeFixture = undefined;
    await deleteQaRateLimits(db);
    const leftovers = await readQaRateLimits(db, "public-edge:");
    const actionLeftovers = await readQaRateLimits(db, "public:auth-password-signin:");
    receipt.cleanup = {
      publicEdgeRateLimitRows: leftovers.length,
      actionAuthRateLimitRows: actionLeftovers.length,
    };
    writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    const evidenceFile = resolve(
      evidenceDirectory,
      `mqa-0148-preview-distributed-${stage}-${candidateSha.slice(0, 8)}-20260825.json`,
    );
    copyFileSync(receiptFile, evidenceFile);
    receipts.push({ stage, runId, evidenceFile, result: receipt.result, summary: receipt.summary });
    if (aggregate.status !== 0 || watch.status !== 0 || receipt.result !== "PASS") {
      throw new Error(`MQA-0148 distributed stage ${stage} failed`);
    }
  }
} finally {
  if (activeFixture) {
    await cleanupTestSalon(activeFixture.slug, { clearAllRateLimits: false });
    await cleanupTestUser(activeFixture.ownerUserId);
  }
  await deleteQaRateLimits(db);
  deleteGithubSecrets();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

process.stdout.write(
  `[MQA-0148-DISTRIBUTED-PASS] ${JSON.stringify({
    candidateSha,
    baseURL,
    supabaseProjectRef: qaProjectRef,
    receipts,
  })}\n`,
);
