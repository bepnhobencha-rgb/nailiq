import { describe, expect, it } from "vitest";

import { approvalExecutionPresentation } from "@/shared/ai/approvalExecutionPresentation";
import type { ExecutionJobStatus } from "@/shared/ai/executionPolicy";

describe("approvalExecutionPresentation", () => {
  it.each([
    ["queued", "Đã đưa vào hàng đợi", "active"],
    ["waiting_input", "Cần thêm thông tin", "attention"],
    ["running", "AI đang thực hiện", "active"],
    ["succeeded", "Đã thực hiện thành công", "success"],
    ["failed", "Thực hiện chưa thành công", "error"],
    ["canceled", "Đã hủy", "neutral"],
  ] as Array<
    [ExecutionJobStatus, string, ReturnType<typeof approvalExecutionPresentation>["tone"]]
  >)("maps %s honestly", (status, label, tone) => {
    expect(approvalExecutionPresentation(status)).toEqual({ label, tone });
  });
});
