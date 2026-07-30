import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const approvals = read("src/shared/ai/approvalRequests.ts");
const controlCenter = read("src/components/dashboard/AiControlCenter.tsx");
const approvalDashboard = read(
  "src/components/dashboard/ApprovalsDashboard.tsx",
);

describe("owner approval view boundary", () => {
  it("does not load capability tokens for owner dashboard reads", () => {
    expect(approvals).toContain("OWNER_APPROVAL_COLUMNS");
    const projection = approvals.match(
      /const OWNER_APPROVAL_COLUMNS =\s*\n?\s*"([^"]+)"/,
    )?.[1];
    expect(projection).toBeDefined();
    expect(projection).not.toMatch(
      /\b(?:approve_token|decline_token|notified_at|reminded_at)\b/,
    );
  });

  it("defines an explicit browser row without raw tenant or payload data", () => {
    const displayType = approvals.match(
      /export type ApprovalDisplayRow = ([\s\S]*?)\n\};/,
    )?.[1];
    expect(displayType).toBeDefined();
    expect(displayType).not.toMatch(
      /\b(?:salon_id|payload|approve_token|decline_token|decided_by|notified_at|reminded_at)\b/,
    );
    expect(approvals).not.toContain("return { ...safe, decision_actor");
  });

  it("gives client surfaces only prebuilt bounded intelligence", () => {
    expect(controlCenter).toContain(
      "const intelligence = request.intelligence[language]",
    );
    expect(controlCenter).not.toContain("request.payload");
    expect(controlCenter).toContain("approvals: ApprovalDisplayRow[]");
    expect(approvalDashboard).toContain("approvals: ApprovalDisplayRow[]");
    expect(approvals).toContain("boundedActionIntelligence");
  });
});
