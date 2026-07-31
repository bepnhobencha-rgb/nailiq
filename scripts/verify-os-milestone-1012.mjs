#!/usr/bin/env node

/**
 * Milestone #1012 verification helper.
 *
 * Goal:
 *  - Validate resend migration script paths are available
 *  - Run the project migration helper in preview mode
 *  - Optionally check key runtime endpoints (best-effort)
 *
 * This is intentionally non-destructive and is safe to run locally.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

const repoRoot = process.cwd();
const requiredFiles = [
  "src/shared/ai/agentStrategist.ts",
  "src/shared/ai/strategistProposal.ts",
  "src/shared/ai/loadMinhActivity.ts",
  "src/shared/ai/__tests__/strategistProposal.spec.ts",
  "scripts/enable-all-salons-email-outbound.mjs",
  "scripts/run-resend-migration.sh",
  "scripts/verify-resend-full.sh",
];
const allowMigrationPreviewFailure = process.env.ALLOW_PREVIEW_FAILURE === "1";

console.log("===== MILESTONE 1012 PRECHECK =====");
if (!existsSync(`${repoRoot}/scripts/enable-all-salons-email-outbound.mjs`)) {
  console.error("❌ Missing scripts/enable-all-salons-email-outbound.mjs");
  process.exit(1);
}
if (!existsSync(`${repoRoot}/scripts/run-resend-migration.sh`)) {
  console.error("❌ Missing scripts/run-resend-migration.sh");
  process.exit(1);
}
console.log("✅ Migration script files are present.");
for (const f of requiredFiles) {
  if (!existsSync(`${repoRoot}/${f}`)) {
    console.error(`❌ Missing required file: ${f}`);
    process.exit(1);
  }
}
console.log("✅ Required milestone 1012 artifacts are present.");

try {
  run("npm run migration:resend-preview");
} catch {
  if (allowMigrationPreviewFailure) {
    console.warn("⚠️ Migration preview failed, but continuing because ALLOW_PREVIEW_FAILURE=1.");
  } else {
    throw new Error("Migration preview failed and ALLOW_PREVIEW_FAILURE is not enabled.");
  }
}

run("npm run test:unit -- src/shared/ai/__tests__/strategistProposal.spec.ts");

const versionUrl = process.env.VERSION_URL || "https://www.nailiq.ca/api/version";
const healthUrl = process.env.HEALTH_URL || "https://www.nailiq.ca/api/health";
console.log("\n===== VERSION CHECK (best-effort) =====");
try {
  run(`curl -sS -m 15 "${versionUrl}"`);
} catch {
  console.warn(`⚠️ Không gọi được version endpoint: ${versionUrl}`);
}

console.log("\n===== HEALTH CHECK (best-effort) =====");
try {
  run(`curl -sS -m 15 "${healthUrl}"`);
} catch {
  console.warn(`⚠️ Không gọi được health endpoint: ${healthUrl}`);
}

console.log("\n===== DONE =====");
