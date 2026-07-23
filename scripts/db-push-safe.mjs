#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";

const CLI_VERSION = "2.109.1";
const apply = process.argv.slice(2).includes("--apply");
const approval = process.env.NAILIQ_DB_PUSH_APPROVAL;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    ...options,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;

  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

const audit = run(process.execPath, [
  "scripts/audit-migration-history.mjs",
  "--deploy-ready",
]);
if (audit.status !== 0) {
  console.error(
    "\nBLOCKED: local migration history is not a safe extension of the audited production ledger.",
  );
  process.exit(audit.status);
}

const cli = ["--yes", `supabase@${CLI_VERSION}`, "db", "push", "--linked"];
const dryRun = run("npx", [...cli, "--dry-run"]);
if (dryRun.status !== 0) {
  console.error("\nBLOCKED: Supabase dry-run failed; no migration was applied.");
  process.exit(dryRun.status);
}

const upToDate = /Remote database is up to date\./i.test(dryRun.output);
if (upToDate) {
  console.log("\nSafe db push check complete: production is already up to date.");
  process.exit(0);
}

if (!apply) {
  console.error(
    [
      "",
      "PENDING MIGRATIONS FOUND — dry-run only; production was not changed.",
      "Rehearse the exact migration on a blank database and prepare rollback.",
      "Only then run:",
      "  NAILIQ_DB_PUSH_APPROVAL=APPLY_REHEARSED_MIGRATIONS npm run db:push -- --apply",
    ].join("\n"),
  );
  process.exit(2);
}

if (approval !== "APPLY_REHEARSED_MIGRATIONS") {
  console.error(
    "\nBLOCKED: --apply requires NAILIQ_DB_PUSH_APPROVAL=APPLY_REHEARSED_MIGRATIONS.",
  );
  process.exit(2);
}

const pushed = run("npx", cli);
if (pushed.status !== 0) {
  console.error("\nSupabase db push failed. Stop and follow the migration rollback plan.");
  process.exit(pushed.status);
}

const verify = run("npx", [...cli, "--dry-run"]);
if (
  verify.status !== 0 ||
  !/Remote database is up to date\./i.test(verify.output)
) {
  console.error(
    "\nPost-push verification failed: production did not report up to date.",
  );
  process.exit(1);
}

console.log(
  "\nMigration apply verified. Refresh the audited production-ledger snapshot before merging dependent application code.",
);
