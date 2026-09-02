import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = process.cwd();

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO, relative), "utf8");
}

describe("TurnIQ M4F Group What-if boundary", () => {
  const adapter = read("src/shared/turniq/trustedGroupRecommendation.ts");
  const actions = read("src/shared/turniq/serverActions.ts");
  const contracts = read("src/shared/turniq/serverContracts.ts");
  const client = read("src/components/receptionist/TurnIqGroupWhatIf.tsx");

  it("loads one shared authoritative snapshot for all three simulations", () => {
    const block = adapter.slice(
      adapter.indexOf("export async function compareTrustedTurnIqGroupTiming"),
      adapter.indexOf("export async function recordTrustedTurnIqStaggeredGroupPlan"),
    );
    expect(block).toContain("loadTrustedGroupDecisionContext");
    expect(block.match(/loadTrustedGroupDecisionContext/g)).toHaveLength(1);
    expect(block).toContain('intent: "start_together"');
    expect(block).toContain('intent: "finish_together"');
    expect(block).toContain('intent: "smart_wave"');
    expect(block).not.toMatch(/\.rpc\(|\.insert\(|\.update\(|\.upsert\(/i);
  });

  it("accepts only salon/group identifiers and bounded timing preferences", () => {
    expect(contracts).toContain("turnIqGroupTimingComparisonActionInputSchema");
    expect(contracts).toContain("windowMinutes");
    expect(contracts).toContain("finishOffsetMinutes");
    const schema = contracts.slice(
      contracts.indexOf("turnIqGroupTimingComparisonActionInputSchema"),
      contracts.indexOf("const sha256Fingerprint"),
    );
    expect(schema).not.toMatch(
      /staffId|resourceId|policyId|fairness|revenue|\btip\b/i,
    );
    expect(actions).toContain("turnIqGroupTimingComparisonActionInputSchema.safeParse");
  });

  it("keeps provider credentials and trusted assignment fields out of the client", () => {
    expect(client).not.toMatch(/serviceRole|supabase|stripe|square|twilio|resend/i);
    const recordInput = client.slice(
      client.indexOf("input: {", client.indexOf("function recordPlan")),
      client.indexOf("...envelope()", client.indexOf("function recordPlan")),
    );
    expect(recordInput).not.toMatch(/staffId|resourceId|fairness|revenue|tip/i);
    expect(client).toContain("bookings change only after a separate confirmation");
  });
});
