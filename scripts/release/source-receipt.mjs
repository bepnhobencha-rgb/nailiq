#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/;

function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    }).trim();
  } catch {
    throw new Error("source_receipt_git_check_failed");
  }
}

/**
 * Read-only pre-deployment evidence. It does not deploy or prove that Vercel
 * received the checked tree; the operator must bind this to the resulting
 * deployment ID and alias in the release record.
 */
export function createSourceReceipt({
  cwd = process.cwd(),
  expectedSha,
  expectedProjectId,
  now = () => new Date(),
  runGit = git,
  readProject = (path) => readFileSync(path, "utf8"),
}) {
  if (!FULL_SHA.test(expectedSha ?? "")) throw new Error("expected_full_sha_required");
  if (!/^prj_[A-Za-z0-9]+$/.test(expectedProjectId ?? "")) {
    throw new Error("expected_project_id_required");
  }

  const root = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (realpathSync(root) !== realpathSync(cwd)) {
    throw new Error("source_receipt_requires_repository_root");
  }

  const sourceSha = runGit(["rev-parse", "--verify", "HEAD"], cwd);
  if (!FULL_SHA.test(sourceSha) || sourceSha !== expectedSha) {
    throw new Error("source_receipt_sha_mismatch");
  }

  if (runGit(["status", "--porcelain=v1", "--untracked-files=all"], cwd) !== "") {
    throw new Error("source_receipt_dirty_checkout");
  }

  const treeSha = runGit(["rev-parse", "HEAD^{tree}"], cwd);
  if (!FULL_SHA.test(treeSha)) throw new Error("source_receipt_invalid_tree");

  let project;
  try {
    project = JSON.parse(readProject(resolve(cwd, ".vercel/project.json")));
  } catch {
    throw new Error("source_receipt_project_link_missing");
  }
  if (!project || typeof project !== "object" ||
    project.projectId !== expectedProjectId || project.projectName !== "nailiq" ||
    typeof project.orgId !== "string" || !project.orgId.startsWith("team_")) {
    throw new Error("source_receipt_wrong_project");
  }

  const checkedAt = now().toISOString();
  return {
    status: "predeploy_only",
    checked_at_utc: checkedAt,
    source_sha: sourceSha,
    source_tree_sha: treeSha,
    vercel_project_id: project.projectId,
    vercel_org_id: project.orgId,
    deployment_metadata: { nailiqSourceSha: sourceSha },
  };
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error("source_receipt_invalid_arguments");
    }
    values.set(key, value);
  }
  if ([...values.keys()].some((key) => !["--expected-sha", "--expected-project-id"].includes(key))) {
    throw new Error("source_receipt_invalid_arguments");
  }
  return values;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const receipt = createSourceReceipt({
      expectedSha: args.get("--expected-sha"),
      expectedProjectId: args.get("--expected-project-id"),
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "source_receipt_failed"}\n`);
    process.exitCode = 1;
  }
}
