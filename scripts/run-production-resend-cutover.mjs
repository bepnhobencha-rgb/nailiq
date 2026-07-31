#!/usr/bin/env node

import { execSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const envPath = join(repoRoot, ".env.local");
const envGlobal = join(repoRoot, ".env");

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnvFile(envPath);
loadEnvFile(envGlobal);

const reportDir = join(repoRoot, ".nailiq-ops");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportFile = join(reportDir, `resend-cutover-${timestamp}.json`);

if (process.env.FORCE_APPLY !== "1") {
  console.error("[blocked] Chỉ cho phép chạy khi FORCE_APPLY=1.");
  console.error("Hãy chạy: FORCE_APPLY=1 npm run cutover:resend-production");
  process.exit(2);
}

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, {
    stdio: opts.quiet ? "pipe" : "inherit",
    cwd: repoRoot,
    encoding: "utf8",
  });
}

async function main() {
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });

  const lines = [];
  let status = "done";

  const log = (line) => {
    lines.push(line);
    console.log(line);
  };

  const writeReport = () => {
    writeFileSync(
      reportFile,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          status,
          lines,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    log(`Saved report: ${reportFile}`);
  };

  try {
    log("===== CUTOVER START =====");

    log("Step 1: status precheck");
    run("npm run resend:status");

    log("Step 2: strict migration run (dry-run+apply+verify)");
    const out = run("npm run migration:resend-run-strict", { quiet: true });
    if (out) log(String(out));

    log("Step 3: status postcheck");
    run("npm run resend:status");

    log("Step 4: run milestone verifier");
    run("ALLOW_PREVIEW_FAILURE=1 npm run verify:milestone-1012", { quiet: true });

    log("Step 5: API checks");
    run("curl -sS https://www.nailiq.ca/api/version || true");
    run("curl -sS https://www.nailiq.ca/api/health || true");

    log("===== CUTOVER DONE =====");
    writeReport();
  } catch (err) {
    status = "failed";
    log(`ERROR: ${err?.message ?? String(err)}`);
    writeReport();
    process.exit(1);
  }
}

main();
