import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = process.cwd();

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO, relative), "utf8");
}

describe("TurnIQ M4E pure group timing simulation boundary", () => {
  const engine = read("src/shared/turniq/groupTimingSimulationEngine.ts");
  const contracts = read("src/shared/turniq/contracts.ts");

  it("has no database, provider, browser mutation or nondeterministic dependency", () => {
    expect(engine).not.toMatch(/supabase|serviceRole|fetch\(|twilio|resend|square|stripe/i);
    expect(engine).not.toMatch(/Date\.now|Math\.random|localStorage|indexedDB/i);
    expect(engine).not.toMatch(/createClient|\.from\(|\.rpc\(|\.insert\(|\.upsert\(/i);
  });

  it("makes simulation-only truth explicit in the typed result", () => {
    expect(contracts).toContain('"start_together"');
    expect(contracts).toContain('"finish_together"');
    expect(contracts).toContain('"smart_wave"');
    expect(contracts).toContain('"TIMING_SIMULATION_ONLY"');
    expect(contracts).toContain("liveStateChanged: false");
    expect(engine).toContain("Simulation only — no booking has changed.");
  });

  it("fails closed when it cannot prove a complete bounded plan", () => {
    expect(engine).toContain("TURNIQ_GROUP_TIMING_MAX_SEARCH_STATES = 350_000");
    expect(engine).toContain("result: limitReached ? null : best");
    expect(engine).toContain('codes.push("TIMING_SEARCH_LIMIT_REACHED")');
    expect(engine).toContain('"TIMING_NO_COMPLETE_PLAN"');
  });

  it("reuses M4A eligibility, resource and duration contracts", () => {
    expect(engine).toContain("validateTurnIqGroupDecisionInput");
    expect(engine).toContain("turnIqGroupCandidateStaticEligible");
    expect(engine).toContain("turnIqGroupResourceCombinations");
    expect(engine).toContain("turnIqGroupTaskDurationMinutes");
  });
});
