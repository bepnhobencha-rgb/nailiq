import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const page = read("src/app/dashboard/[slug]/approvals/page.tsx");
const dashboard = read("src/components/dashboard/ApprovalsDashboard.tsx");

describe("approval inbox availability boundary", () => {
  it("loads approval and execution sources independently", () => {
    expect(page).toContain("Promise.allSettled");
    expect(page).toContain('approvalsResult.status === "fulfilled"');
    expect(page).toContain('executionJobsResult.status === "fulfilled"');
    expect(page).toContain("approvalsAvailable={approvalsAvailable}");
    expect(page).toContain(
      "executionJobsAvailable={executionJobsAvailable}",
    );
  });

  it("does not turn an unavailable approval source into an empty success", () => {
    expect(dashboard).toContain(
      'Đang chờ {approvalsAvailable ? `(${pending.length})` : "(chưa xác minh)"}',
    );
    expect(dashboard).toMatch(
      /NailIQ không\s+khẳng định rằng hiện không có việc chờ duyệt\./,
    );
    expect(dashboard).toContain(
      "!approvalsAvailable ? (",
    );
  });

  it("distinguishes an unavailable execution source from a proven missing job", () => {
    expect(dashboard).toContain(
      'req.status === "approved" && executionJobsAvailable && !job',
    );
    expect(dashboard).toContain(
      'req.status === "approved" && !executionJobsAvailable',
    );
    expect(dashboard).toContain("Chưa xác minh được thực thi");
    expect(dashboard).toContain(
      "không được xem là đã thực hiện cho đến khi NailIQ xác minh lại",
    );
  });
});
