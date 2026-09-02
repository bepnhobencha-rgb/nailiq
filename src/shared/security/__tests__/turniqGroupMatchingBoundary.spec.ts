import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = process.cwd();

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO, relative), "utf8");
}

describe("TurnIQ M4A pure group matching boundary", () => {
  const engine = read("src/shared/turniq/groupMatchingEngine.ts");

  it("has no database, provider, browser mutation or nondeterministic dependency", () => {
    expect(engine).not.toMatch(/supabase|serviceRole|fetch\(|twilio|resend|square|stripe/i);
    expect(engine).not.toMatch(/Date\.now|Math\.random|localStorage|indexedDB/i);
    expect(engine).not.toMatch(/booking.*(?:insert|update|delete)/i);
  });

  it("keeps a bounded fail-closed exact search", () => {
    expect(engine).toContain("TURNIQ_GROUP_MAX_PARTY_SIZE = 12");
    expect(engine).toContain("TURNIQ_GROUP_MAX_SEARCH_STATES = 250_000");
    expect(engine).toContain("limitReached ? null : best");
    expect(engine).toContain('reasonCodes.push("GROUP_SEARCH_LIMIT_REACHED")');
  });

  it("keeps the settled lexicographic objective order explicit", () => {
    const contracts = read("src/shared/turniq/contracts.ts");
    expect(contracts).toContain('"feasibility"');
    expect(contracts).toContain('"requested_technician"');
    expect(contracts).toContain('"appointment_safety"');
    expect(contracts).toContain('"customer_wait"');
    expect(contracts).toContain('"fairness_cost"');
    expect(contracts).toContain('"stable_tie_break"');
  });
});
