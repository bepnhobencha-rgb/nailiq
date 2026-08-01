import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const page = read("src/app/dashboard/[slug]/ai/page.tsx");
const controlCenter = read("src/components/dashboard/AiControlCenter.tsx");
const approvals = read("src/shared/ai/approvalRequests.ts");
const activity = read("src/shared/ai/loadMinhActivity.ts");
const queue = read("src/shared/ai/executionQueue.ts");
const exceptions = read("src/shared/ai/operationalExceptions.ts");
const operatingState = read("src/shared/ai/operatingState.ts");
const lessons = read("src/shared/ai/lessons.ts");

describe("AI Control Center data-truth boundary", () => {
  it("settles independent sources so one read failure does not hide the rest", () => {
    expect(page).toContain("Promise.allSettled");
    expect(page).toMatch(/resolveAiControlSource\(\s*"approvals"/);
    expect(page).toMatch(/resolveAiControlSource\(\s*"activity"/);
    expect(page).toMatch(/resolveAiControlSource\(\s*"execution_queue"/);
    expect(page).toMatch(/resolveAiControlSource\(\s*"operating_state"/);
    expect(page).toMatch(/resolveAiControlSource\(\s*"operational_exceptions"/);
    expect(page).toContain("unavailableSources={unavailableSources}");
  });

  it("makes every owner-facing primary read fail explicitly", () => {
    expect(approvals).toContain("approval_requests_read_failed");
    expect(activity).toContain("ai_actions_log_read_failed");
    expect(queue).toContain("ai_execution_jobs_read_failed");
    expect(exceptions).toContain("operational_exceptions_read_failed");
    expect(operatingState).toContain("ai_execution_${status}_count_failed");
    expect(operatingState).toContain("{ throwOnError: true }");
    expect(lessons).toContain(
      'options.throwOnError ? "strict" : "tolerant"',
    );
  });

  it("never presents a read failure as zero, empty, or healthy", () => {
    expect(controlCenter).toContain('data-testid="ai-control-data-unavailable"');
    expect(controlCenter).toContain(
      "NailIQ không thay lỗi đọc bằng số 0 hoặc trạng thái khỏe",
    );
    expect(controlCenter).toContain(
      "Trạng thái trống không được giả định",
    );
    expect(controlCenter).toContain(
      "Chưa thể xác minh trạng thái AI",
    );
    expect(controlCenter).toContain("operationalExceptionsAvailable ?");
  });
});
