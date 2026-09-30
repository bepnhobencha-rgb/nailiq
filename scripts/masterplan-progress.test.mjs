import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { evaluateProgress, isScheduledHour, readProgress } from "./masterplan-progress.mjs";

const now = new Date("2026-09-30T16:00:00Z");
const context = { now, evidenceExists: () => true, sourceUnchanged: () => true };
function manifest() {
  return { version: 1, timezone: "America/Vancouver", dailyHour: 9, selfPayRequired: true,
    phases: Array.from({ length: 7 }, (_, index) => ({ id: index + 1, status: "incomplete" })) };
}
function accepted() {
  const value = manifest();
  for (const phase of value.phases) {
    phase.status = "accepted";
    phase.acceptance = { reviewedBy: "Owner review", reviewedAt: "2026-09-29T12:00:00Z",
      sourceSha: "a".repeat(40), evidence: ["docs/qa/acceptance.md"], humanAcceptance: true, selfPayVerified: true };
    if (phase.id === 5 || phase.id === 7) {
      phase.acceptance.observation = { startedAt: phase.id === 5 ? "2026-09-20T12:00:00Z" : "2026-08-20T12:00:00Z", endedAt: "2026-09-29T12:00:00Z" };
      phase.acceptance.metrics = phase.id === 5
        ? { salons: 3, olderOwners: 1, lowTechReceptionists: 2, independentCompletionPercent: 80, bookingSeconds: 59, walkInSeconds: 29, firstShiftHelpCount: 1, dataLossIncidents: 0, continuingSalons: 2 }
        : { salons: 10, signupPercent: 40, setupPercent: 70, firstBooking24hPercent: 60, trialConversionPercent: 30, weekOneSupportPerSalon: 1 };
    }
  }
  return value;
}

test("stops only with seven valid phase receipts", () => {
  assert.equal(evaluateProgress(accepted(), context).complete, true);
  const value = accepted(); value.phases[6].status = "incomplete";
  assert.equal(evaluateProgress(value, context).complete, false);
  assert.equal(evaluateProgress(manifest(), context).percent, 0);
});
test("a PASS label without evidence cannot stop the worker", () => {
  const value = accepted(); delete value.phases[0].acceptance;
  assert.throws(() => evaluateProgress(value, context), /receipt_required/);
  assert.throws(() => evaluateProgress(accepted(), { ...context, evidenceExists: () => false }), /receipt_required/);
});
test("code changes reopen accepted phases", () => {
  assert.equal(evaluateProgress(accepted(), { ...context, sourceUnchanged: () => false }).complete, false);
});
test("manual activation cannot count as self-pay", () => {
  const value = accepted(); value.phases[5].acceptance.selfPayVerified = false;
  assert.throws(() => evaluateProgress(value, context), /self_pay_acceptance_required/);
});
test("robot tests cannot substitute for pilot/device/human acceptance", () => {
  for (const id of [2, 3, 5, 7]) {
    const value = accepted(); value.phases[id - 1].acceptance.humanAcceptance = false;
    assert.throws(() => evaluateProgress(value, context), /human_acceptance_required/);
  }
});
test("missing, duplicate, and unsupported criteria fail closed", () => {
  const missing = manifest(); missing.phases.pop();
  assert.throws(() => evaluateProgress(missing, context), /seven_phases_required/);
  const duplicate = manifest(); duplicate.phases[6].id = 1;
  assert.throws(() => evaluateProgress(duplicate, context), /invalid_phase_ids/);
  const stringId = accepted(); stringId.phases[5].id = "6"; delete stringId.phases[5].acceptance.selfPayVerified;
  assert.throws(() => evaluateProgress(stringId, context), /invalid_phase_ids/);
  const invalid = manifest(); invalid.selfPayRequired = false;
  assert.throws(() => evaluateProgress(invalid, context), /invalid_masterplan_contract/);
});
test("future acceptance timestamps are rejected", () => {
  const value = accepted(); value.phases[0].acceptance.reviewedAt = "2027-01-01T00:00:00Z";
  assert.throws(() => evaluateProgress(value, context), /receipt_required/);
});
test("a short test run cannot count as 7–14 pilot days or a 30-day cohort", () => {
  for (const id of [5, 7]) {
    const value = accepted(); value.phases[id - 1].acceptance.observation.startedAt = "2026-09-29T11:00:00Z";
    assert.throws(() => evaluateProgress(value, context), /observed_time_required/);
  }
});
test("failed or missing pilot/cohort KPIs cannot close acceptance", () => {
  const value = accepted(); value.phases[4].acceptance.metrics.walkInSeconds = 30;
  assert.throws(() => evaluateProgress(value, context), /pilot_acceptance_required/);
  const missing = accepted(); delete missing.phases[4].acceptance.metrics.olderOwners;
  assert.throws(() => evaluateProgress(missing, context), /complete_metrics_required/);
  const cohort = accepted(); cohort.phases[6].acceptance.metrics.trialConversionPercent = 29;
  assert.throws(() => evaluateProgress(cohort, context), /cohort_acceptance_required/);
});
test("09:00 Vancouver follows summer and winter time", () => {
  assert.equal(isScheduledHour(new Date("2026-09-30T16:00:00Z")), true);
  assert.equal(isScheduledHour(new Date("2026-09-30T17:00:00Z")), false);
  assert.equal(isScheduledHour(new Date("2026-12-01T17:00:00Z")), true);
  assert.equal(isScheduledHour(new Date("2026-12-01T16:00:00Z")), false);
});
test("real repository gate rejects escaped evidence and untracked application code", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nailiq-progress-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    fs.mkdirSync(path.join(root, "docs/qa"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "docs/qa/acceptance.md"), "Synthetic gate test evidence, not real acceptance.\n");
    fs.writeFileSync(path.join(root, "src/app.ts"), "export const state = 1;\n");
    git("init"); git("config", "user.name", "Gate Test"); git("config", "user.email", "gate@test.invalid");
    git("add", "."); git("commit", "-m", "test fixture");
    const value = accepted();
    for (const phase of value.phases) phase.acceptance.sourceSha = git("rev-parse", "HEAD").trim();
    const write = () => fs.writeFileSync(path.join(root, "docs/qa/masterplan-progress.json"), JSON.stringify(value));
    write();
    assert.equal(readProgress(root).complete, true);
    fs.writeFileSync(path.join(root, "src/new.ts"), "export const unreviewed = true;\n");
    assert.equal(readProgress(root).complete, false);
    fs.unlinkSync(path.join(root, "src/new.ts"));
    fs.writeFileSync(path.join(root, "src/app.ts"), "export const state = 2;\n");
    assert.equal(readProgress(root).complete, false);
    fs.writeFileSync(path.join(root, "src/app.ts"), "export const state = 1;\n");
    value.phases[0].acceptance.evidence = ["docs/qa/../../src/app.ts"];
    write();
    assert.throws(() => readProgress(root), /receipt_required/);
    fs.symlinkSync(path.join(root, "src/app.ts"), path.join(root, "docs/qa/escaped.md"));
    value.phases[0].acceptance.evidence = ["docs/qa/escaped.md"];
    write();
    assert.throws(() => readProgress(root), /receipt_required/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
