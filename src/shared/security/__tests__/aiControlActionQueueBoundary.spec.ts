import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const clientFiles = [
  "src/components/dashboard/AiControlCenter.tsx",
  "src/components/dashboard/ApprovalDecisionButtons.tsx",
  "src/components/dashboard/OperationalExceptionInbox.tsx",
].map((path) => readFileSync(resolve(process.cwd(), path), "utf8"));

describe("AI Control Center App Router action queue boundary", () => {
  it("does not import server actions into the client-rendered control surface", () => {
    for (const source of clientFiles) {
      expect(source).toContain('from "@/shared/ai/aiControlApi"');
      expect(source).not.toMatch(
        /from\s+["']@\/shared\/ai\/(?:decideApprovalAction|controlOperationalExceptionAction|controlExecutionJobAction|prepareAudienceAction|preflightCampaignAction|sealCampaignPlanAction)["']/,
      );
    }
  });
});
