import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSourceReceipt } from "./source-receipt.mjs";

const projectId = "prj_123456789";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "nailiq-source-receipt-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, ["init", "-q"]);
  mkdirSync(join(cwd, ".vercel"));
  writeFileSync(join(cwd, ".gitignore"), ".vercel/\n");
  writeFileSync(join(cwd, "tracked.txt"), "candidate\n");
  writeFileSync(join(cwd, ".vercel/project.json"), JSON.stringify({
    projectId,
    projectName: "nailiq",
    orgId: "team_123456789",
  }));
  git(cwd, ["add", ".gitignore", "tracked.txt"]);
  git(cwd, ["-c", "user.name=NailIQ QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "candidate"]);
  return { cwd, sha: git(cwd, ["rev-parse", "HEAD"]) };
}

test("emits a predeploy-only receipt for the exact clean linked checkout", (t) => {
  const { cwd, sha } = fixture(t);
  const receipt = createSourceReceipt({
    cwd,
    expectedSha: sha,
    expectedProjectId: projectId,
    now: () => new Date("2026-09-28T12:00:00Z"),
  });
  assert.equal(receipt.status, "predeploy_only");
  assert.equal(receipt.source_sha, sha);
  assert.equal(receipt.source_tree_sha, git(cwd, ["rev-parse", "HEAD^{tree}"]));
  assert.equal(receipt.vercel_project_id, projectId);
  assert.deepEqual(receipt.deployment_metadata, { nailiqSourceSha: sha });
  assert.equal(receipt.checked_at_utc, "2026-09-28T12:00:00.000Z");
});

test("rejects a different candidate or Vercel project", (t) => {
  const { cwd, sha } = fixture(t);
  assert.throws(() => createSourceReceipt({ cwd, expectedSha: "a".repeat(40), expectedProjectId: projectId }),
    /source_receipt_sha_mismatch/);
  assert.throws(() => createSourceReceipt({ cwd, expectedSha: sha, expectedProjectId: "prj_wrong" }),
    /source_receipt_wrong_project/);
});

test("rejects tracked and untracked changes", (t) => {
  const { cwd, sha } = fixture(t);
  writeFileSync(join(cwd, "tracked.txt"), "edited\n");
  assert.throws(() => createSourceReceipt({ cwd, expectedSha: sha, expectedProjectId: projectId }),
    /source_receipt_dirty_checkout/);
  writeFileSync(join(cwd, "tracked.txt"), "candidate\n");
  writeFileSync(join(cwd, "untracked.txt"), "new\n");
  assert.throws(() => createSourceReceipt({ cwd, expectedSha: sha, expectedProjectId: projectId }),
    /source_receipt_dirty_checkout/);
});

test("rejects staged changes and a nested working directory", (t) => {
  const { cwd, sha } = fixture(t);
  mkdirSync(join(cwd, "nested"));
  assert.throws(() => createSourceReceipt({ cwd: join(cwd, "nested"), expectedSha: sha, expectedProjectId: projectId }),
    /source_receipt_requires_repository_root/);
  writeFileSync(join(cwd, "tracked.txt"), "staged\n");
  git(cwd, ["add", "tracked.txt"]);
  assert.throws(() => createSourceReceipt({ cwd, expectedSha: sha, expectedProjectId: projectId }),
    /source_receipt_dirty_checkout/);
});

test("rejects a missing project link", (t) => {
  const { cwd, sha } = fixture(t);
  rmSync(join(cwd, ".vercel/project.json"));
  assert.throws(() => createSourceReceipt({ cwd, expectedSha: sha, expectedProjectId: projectId }),
    /source_receipt_project_link_missing/);
});

test("requires explicit full SHA and project identity", (t) => {
  const { cwd, sha } = fixture(t);
  assert.throws(() => createSourceReceipt({ cwd, expectedSha: sha.slice(0, 8), expectedProjectId: projectId }),
    /expected_full_sha_required/);
  assert.throws(() => createSourceReceipt({ cwd, expectedSha: sha }),
    /expected_project_id_required/);
});
