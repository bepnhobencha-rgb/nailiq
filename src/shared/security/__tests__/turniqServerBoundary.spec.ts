import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const actions = fs.readFileSync(
  path.join(root, "src/shared/turniq/serverActions.ts"),
  "utf8",
);
const dal = fs.readFileSync(
  path.join(root, "src/shared/turniq/serverDal.ts"),
  "utf8",
);

describe("TurnIQ M3B server boundary", () => {
  it("keeps Server Actions thin, validated and free of service-role imports", () => {
    expect(actions.startsWith('"use server"')).toBe(true);
    expect(actions).toContain("safeParse");
    expect(actions).not.toContain("createServiceRoleClient");
    expect(actions).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("keeps privileged access in a server-only DAL behind membership and feature checks", () => {
    expect(dal.startsWith('import "server-only"')).toBe(true);
    expect(dal).toContain("getDashboardWriteClient(slug)");
    expect(dal).toContain('ctx.kind !== "member"');
    expect(dal).toContain('"turniq_trust_engine"');
    expect(dal).toContain("isReleaseFeatureVisible");
    expect(dal).toContain("loadTurnIqRolloutStage");
    expect(dal).toContain("turnIqStageAllowsRead");
  });

  it("does not export recommendation persistence as a browser-callable Server Action", () => {
    expect(actions).not.toContain("recordTrustedTurnIqRecommendation");
    expect(dal).toContain("export async function recordTrustedTurnIqRecommendation");
    expect(dal).toContain("browser input must never be");
    expect(dal).toContain("decideSingleCustomer(input.decisionInput)");
  });

  it("returns role-shaped projections rather than raw internal trace or payment truth", () => {
    const exportedActionBlock = actions;
    expect(exportedActionBlock).not.toContain("internal_decision_trace");
    expect(exportedActionBlock).not.toContain("actual_tip_cents");
    expect(exportedActionBlock).not.toContain("actual_service_revenue_cents");
  });
});
