import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const queue = read("src/shared/ai/executionQueue.ts");
const page = read("src/app/dashboard/[slug]/ai/page.tsx");
const controlCenter = read("src/components/dashboard/AiControlCenter.tsx");

describe("approval execution trace boundary", () => {
  it("loads exact recent approvals inside the active salon", () => {
    expect(queue).toContain(".eq(\"salon_id\" as never, salonId)");
    expect(queue).toContain(".in(\"approval_request_id\" as never, ids)");
    expect(queue).toContain(".slice(0, 20)");
    expect(page).toContain("getApprovalExecutionTraces");
  });

  it("passes a deliberately minimized trace to the client", () => {
    expect(queue).toContain("export type ApprovalExecutionTraceRow");
    expect(queue).toContain("blocker: string | null");
    const traceType = queue.match(
      /type ApprovalExecutionTraceRow = \{([\s\S]*?)\n\};/,
    )?.[1];
    expect(traceType).toBeDefined();
    expect(traceType).not.toMatch(
      /\b(?:payload|idempotency_key|lease_token|result|last_error)\b/,
    );
    expect(controlCenter).toContain(
      "decisionExecutionTraces: ApprovalExecutionTraceRow[]",
    );
  });

  it("fails visibly instead of treating a missing trace as success", () => {
    expect(page).toContain('unavailableSources.push("decision_execution_trace")');
    expect(controlCenter).toContain(
      "Không thể tải dấu vết thực thi; chưa thể xác minh kết quả của quyết định.",
    );
    expect(controlCenter).toContain(
      "approvalDecisionExecutionPresentation",
    );
  });
});
