import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const approvals = read("src/shared/ai/approvalRequests.ts");
const activity = read("src/shared/ai/loadMinhActivity.ts");
const page = read("src/app/dashboard/[slug]/ai/page.tsx");
const controlCenter = read("src/components/dashboard/AiControlCenter.tsx");

describe("AI Control Center metric-truth boundary", () => {
  it("counts every pending approval independently of its bounded preview", () => {
    expect(approvals).toContain("getApprovalInboxSnapshot");
    expect(approvals).toContain('.eq("status" as never, "pending")');
    expect(approvals).toContain(
      '.select("id", { count: "exact", head: true })',
    );
    expect(approvals).toContain("pending_approval_count_unavailable");
    expect(approvals).toContain("pendingCount: countResult.count");
    expect(page).toContain("pendingApprovalCount={approvalInbox.pendingCount}");
    expect(controlCenter).toContain(
      "approvalsAvailable ? pendingApprovalCount :",
    );
  });

  it("uses an exact 30-day action count rather than the 200-row preview", () => {
    expect(activity).toContain('count: "exact"');
    expect(activity).toContain(".limit(200)");
    expect(activity).toContain("ai_actions_log_count_unavailable");
    expect(activity).toContain("totalActions: count");
    expect(controlCenter).toContain(
      "activityAvailable ? activity.totalActions :",
    );
    expect(controlCenter).not.toContain(
      "activityAvailable ? activity.entries.length :",
    );
  });
});
