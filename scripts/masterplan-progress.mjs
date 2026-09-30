#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function isScheduledHour(now) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver", hour: "2-digit", hourCycle: "h23",
  }).format(now) === "09";
}

export function evaluateProgress(manifest, { evidenceExists, sourceUnchanged, now = new Date() }) {
  if (manifest.version !== 1 || manifest.timezone !== "America/Vancouver" || manifest.dailyHour !== 9 || manifest.selfPayRequired !== true) {
    throw new Error("invalid_masterplan_contract");
  }
  if (!Array.isArray(manifest.phases) || manifest.phases.length !== 7) throw new Error("seven_phases_required");
  if (!manifest.phases.every((phase) => Number.isInteger(phase.id))) throw new Error("invalid_phase_ids");
  const ids = manifest.phases.map((phase) => phase.id).sort();
  if (ids.join(",") !== "1,2,3,4,5,6,7") throw new Error("invalid_phase_ids");
  const phases = manifest.phases.map((phase) => {
    if (!["incomplete", "accepted"].includes(phase.status)) throw new Error("invalid_phase_status");
    if (phase.status !== "accepted") return { id: phase.id, name: phase.name, accepted: false, remaining: phase.remaining };
    const proof = phase.acceptance;
    if (!proof || typeof proof.reviewedBy !== "string" || !proof.reviewedBy.trim() ||
      !Number.isFinite(Date.parse(proof.reviewedAt)) || Date.parse(proof.reviewedAt) > now.getTime() ||
      !/^[a-f0-9]{40}$/.test(proof.sourceSha ?? "") || !Array.isArray(proof.evidence) || !proof.evidence.length ||
      !proof.evidence.every((file) => typeof file === "string" && evidenceExists(file))) {
      throw new Error(`phase_${phase.id}_acceptance_receipt_required`);
    }
    if (phase.id === 6 && proof.selfPayVerified !== true) throw new Error("self_pay_acceptance_required");
    if ([2, 3, 5, 7].includes(phase.id) && proof.humanAcceptance !== true) throw new Error("human_acceptance_required");
    if ([5, 7].includes(phase.id)) {
      const start = Date.parse(proof.observation?.startedAt);
      const end = Date.parse(proof.observation?.endedAt);
      const days = (end - start) / 86_400_000;
      if (!Number.isFinite(days) || end > now.getTime() || days < (phase.id === 5 ? 7 : 30) ||
        (phase.id === 5 && days > 14)) throw new Error("observed_time_required");
      const metrics = proof.metrics;
      if (phase.id === 5 && (!metrics || metrics.salons !== 3 || metrics.olderOwners < 1 ||
        metrics.lowTechReceptionists < 2 || metrics.independentCompletionPercent < 80 ||
        metrics.bookingSeconds >= 60 || metrics.walkInSeconds >= 30 || metrics.firstShiftHelpCount > 1 ||
        metrics.dataLossIncidents !== 0 || metrics.continuingSalons < 2)) throw new Error("pilot_acceptance_required");
      if (phase.id === 7 && (!metrics || metrics.salons < 1 || metrics.salons > 10 ||
        metrics.signupPercent < 40 || metrics.setupPercent < 70 || metrics.firstBooking24hPercent < 60 ||
        metrics.trialConversionPercent < 30 || metrics.weekOneSupportPerSalon >= 2)) throw new Error("cohort_acceptance_required");
      const required = phase.id === 5
        ? ["salons", "olderOwners", "lowTechReceptionists", "independentCompletionPercent", "bookingSeconds", "walkInSeconds", "firstShiftHelpCount", "dataLossIncidents", "continuingSalons"]
        : ["salons", "signupPercent", "setupPercent", "firstBooking24hPercent", "trialConversionPercent", "weekOneSupportPerSalon"];
      if (!required.every((key) => Number.isFinite(metrics[key]) && metrics[key] >= 0)) throw new Error("complete_metrics_required");
      if (required.some((key) => key.endsWith("Percent") && metrics[key] > 100) ||
        (phase.id === 5 && metrics.continuingSalons > metrics.salons)) throw new Error("invalid_metrics");
    }
    if (!sourceUnchanged(proof.sourceSha)) return { id: phase.id, name: phase.name, accepted: false, remaining: "Source changed since acceptance; revalidation required." };
    return { id: phase.id, name: phase.name, accepted: true };
  });
  const accepted = phases.filter((phase) => phase.accepted).length;
  return {
    metric: "Fully accepted Master Plan phases; not code coverage or test pass rate",
    accepted, total: 7, percent: Math.round(accepted / 7 * 10000) / 100,
    complete: accepted === 7, phases,
  };
}

function localEvidenceExists(root, relative) {
  // Evidence must be a repository document, never an arbitrary file or URL.
  if (!relative.startsWith("docs/qa/") || relative.includes("..") || path.isAbsolute(relative)) return false;
  try {
    const actual = fs.realpathSync(path.resolve(root, relative));
    return actual.startsWith(`${fs.realpathSync(path.join(root, "docs/qa"))}${path.sep}`) && fs.statSync(actual).isFile();
  } catch { return false; }
}

export function readProgress(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "docs/qa/masterplan-progress.json"), "utf8"));
  return evaluateProgress(manifest, {
    evidenceExists: (file) => localEvidenceExists(root, file),
    sourceUnchanged: (sha) => {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: root, stdio: "pipe" });
        // Evidence-only updates do not invalidate acceptance, application changes do.
        execFileSync("git", ["diff", "--exit-code", sha, "--", "src", "supabase", "package.json", "package-lock.json", "pnpm-lock.yaml", "next.config.ts", "scripts", "qa", "e2e", ".github"], { cwd: root, stdio: "pipe" });
        const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "src", "supabase", "scripts", "qa", "e2e", ".github"], { cwd: root, encoding: "utf8" });
        if (untracked.trim()) return false;
        return true;
      } catch { return false; }
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes("--schedule-gate")) {
    process.stdout.write(`${isScheduledHour(new Date())}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(readProgress(process.cwd()), null, 2)}\n`);
  }
}
