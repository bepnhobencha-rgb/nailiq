import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO = process.cwd();

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO, relative), "utf8");
}

describe("TurnIQ M4H supervised staggered apply boundary", () => {
  const adapter = read("src/shared/turniq/trustedGroupRecommendation.ts");
  const contracts = read("src/shared/turniq/serverContracts.ts");
  const actions = read("src/shared/turniq/serverActions.ts");
  const client = read("src/components/receptionist/TurnIqGroupWhatIf.tsx");

  it("accepts simulation identity and bounded preferences, never trusted assignments", () => {
    const schema = contracts.slice(
      contracts.indexOf("turnIqStaggeredGroupPlanActionInputSchema"),
      contracts.indexOf("});", contracts.indexOf("turnIqStaggeredGroupPlanActionInputSchema")) + 3,
    );
    expect(schema).toContain("expectedSimulationFingerprint");
    expect(schema).toContain("expectedSnapshotVersion");
    expect(schema).toContain("comparedAt");
    expect(schema).not.toMatch(/staffId|resourceId|fairness|revenue|\btip\b|trace/i);
    expect(actions).toContain("turnIqStaggeredGroupPlanActionInputSchema.safeParse");
  });

  it("reloads, recomputes and verifies the exact displayed simulation before RPC", () => {
    const block = adapter.slice(
      adapter.indexOf("export async function recordTrustedTurnIqStaggeredGroupPlan"),
      adapter.indexOf("export async function confirmTrustedTurnIqStaggeredGroupPlan"),
    );
    expect(block).toContain("loadTrustedGroupDecisionContext");
    expect(block).toContain("simulateTurnIqGroupTiming");
    expect(block).toContain("input.expectedSimulationId");
    expect(block).toContain("input.expectedSimulationFingerprint");
    expect(block).toContain("input.expectedSnapshotVersion");
    expect(block.indexOf("simulateTurnIqGroupTiming")).toBeLessThan(
      block.indexOf('"record_turniq_staggered_group_plan_v1"'),
    );
    expect(block.indexOf("replayGroupCommand")).toBeLessThan(
      block.indexOf("occurredAtMs - comparedAtMs"),
    );
  });

  it("requires a separate state-versioned atomic confirmation", () => {
    const block = adapter.slice(
      adapter.indexOf("export async function confirmTrustedTurnIqStaggeredGroupPlan"),
      adapter.indexOf("export async function confirmTrustedTurnIqGroup"),
    );
    expect(block).toContain('plan.status !== "recommended"');
    expect(block).toContain('safeInteger(plan, "state_version")');
    expect(block).toContain('"confirm_turniq_staggered_group_plan_v1"');
    expect(block.indexOf("replayGroupCommand")).toBeLessThan(
      block.indexOf('plan.status !== "recommended"'),
    );
    expect(client).toContain("Booking vẫn chưa đổi");
    expect(client).not.toMatch(/serviceRole|supabase|stripe|square|twilio|resend/i);
  });
});
