import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const queue = read("src/shared/ai/executionQueue.ts");
const ownerView = read("src/shared/ai/executionOwnerView.ts");
const controlCenter = read("src/components/dashboard/AiControlCenter.tsx");
const approvals = read("src/components/dashboard/ApprovalsDashboard.tsx");

describe("owner execution view boundary", () => {
  it("selects a narrow owner projection instead of the full queue row", () => {
    expect(queue).toContain("getOwnerExecutionJobs");
    expect(queue).toContain(
      "id,approval_request_id,action_type,status,attempt_count,max_attempts,last_error,result,created_at",
    );
    const ownerQuery = queue.match(
      /export async function getOwnerExecutionJobs([\s\S]*?)\n\}/,
    )?.[1];
    expect(ownerQuery).toBeDefined();
    expect(ownerQuery).not.toContain('.select("*")');
    const projection = ownerQuery?.match(
      /\.select\(\s*"([^"]+)"/,
    )?.[1];
    expect(projection).toBeDefined();
    expect(projection).not.toMatch(
      /\b(?:payload|idempotency_key|lease_token|lease_expires_at|salon_id)\b/,
    );
  });

  it("gives client surfaces only the minimized owner type", () => {
    expect(controlCenter).toContain("executionJobs: OwnerExecutionJob[]");
    expect(approvals).toContain("executionJobs: OwnerExecutionJob[]");
    expect(controlCenter).not.toContain("ExecutionJobRow");
    expect(approvals).not.toContain("ExecutionJobRow");

    const ownerType = ownerView.match(
      /export type OwnerExecutionJob = \{([\s\S]*?)\n\};/,
    )?.[1];
    expect(ownerType).toBeDefined();
    expect(ownerType).not.toMatch(
      /\b(?:salon_id|payload|idempotency_key|lease_token|lease_expires_at|available_at)\b/,
    );
  });

  it("allowlists results and sanitizes failure text before serialization", () => {
    expect(ownerView).toContain("toOwnerExecutionResult(row.result)");
    expect(ownerView).toContain("toSafeExecutionFailureCode(row.last_error)");
    expect(ownerView).not.toContain("plan_fingerprint:");
    expect(ownerView).not.toContain("plan_id:");
  });

  it("shows an approved decision without a job as an integrity issue", () => {
    expect(approvals).toContain(
      'const missingApprovedExecution = req.status === "approved" && !job',
    );
    expect(approvals).toContain("Thiếu dấu vết thực thi");
    expect(approvals).toMatch(
      /chưa\s+thể xác minh hành động đã được thực thi/,
    );
  });
});
