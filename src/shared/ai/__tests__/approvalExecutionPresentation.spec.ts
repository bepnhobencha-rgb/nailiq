import { describe, expect, it } from "vitest";

import {
  approvalDecisionExecutionPresentation,
  approvalExecutionPresentation,
} from "@/shared/ai/approvalExecutionPresentation";
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

  it("names both campaign gates instead of showing a generic input state", () => {
    expect(
      approvalExecutionPresentation("waiting_input", "release_approval_required"),
    ).toEqual({ label: "Chờ duyệt phát hành", tone: "attention" });
    expect(
      approvalExecutionPresentation("waiting_input", "dispatch_not_enabled"),
    ).toEqual({ label: "Đã duyệt — chưa bật gửi", tone: "attention" });
  });
});

describe("approvalDecisionExecutionPresentation", () => {
  const job = {
    approval_request_id: "approval-1",
    status: "running" as const,
    attempt_count: 1,
    max_attempts: 3,
    blocker: null,
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:01:00.000Z",
  };

  it("makes declined and expired decisions explicitly non-executing", () => {
    expect(
      approvalDecisionExecutionPresentation("declined", undefined, "vi"),
    ).toMatchObject({
      label: "Không thực thi — đã từ chối",
      tone: "neutral",
    });
    expect(
      approvalDecisionExecutionPresentation("expired", undefined, "en"),
    ).toMatchObject({
      label: "Not executed — request expired",
      tone: "neutral",
    });
  });

  it("treats an approved decision without a job as an integrity issue", () => {
    expect(
      approvalDecisionExecutionPresentation("approved", undefined, "vi"),
    ).toMatchObject({
      label: "Không tìm thấy bản ghi thực thi",
      tone: "error",
    });
  });

  it("reports the authoritative job state and bounded attempts", () => {
    expect(
      approvalDecisionExecutionPresentation("approved", job, "vi"),
    ).toEqual({
      label: "AI đang thực hiện",
      detail: "Lần thử 1/3.",
      tone: "active",
    });
  });
});
