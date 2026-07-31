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

run("npm run migration:resend-preview");

const versionUrl = process.env.VERSION_URL || "https://www.nailiq.ca/api/version";
const healthUrl = process.env.HEALTH_URL || "https://www.nailiq.ca/api/health";
console.log("\n===== VERSION CHECK (best-effort) =====");
try {
  run(`curl -sS -m 15 "${versionUrl}"`);
} catch (e) {
  console.warn(`⚠️ Không gọi được version endpoint: ${versionUrl}`);
}

console.log("\n===== HEALTH CHECK (best-effort) =====");
try {
  run(`curl -sS -m 15 "${healthUrl}"`);
} catch (e) {
  console.warn(`⚠️ Không gọi được health endpoint: ${healthUrl}`);
}

console.log("\n===== DONE =====");
