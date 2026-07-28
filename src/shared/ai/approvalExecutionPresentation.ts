import type { ExecutionJobStatus } from "@/shared/ai/executionPolicy";

export type ApprovalExecutionPresentation = {
  label: string;
  tone: "neutral" | "attention" | "active" | "success" | "error";
};

const PRESENTATION: Record<
  ExecutionJobStatus,
  ApprovalExecutionPresentation
> = {
  queued: { label: "Đã đưa vào hàng đợi", tone: "active" },
  waiting_input: { label: "Cần thêm thông tin", tone: "attention" },
  running: { label: "AI đang thực hiện", tone: "active" },
  succeeded: { label: "Đã thực hiện thành công", tone: "success" },
  failed: { label: "Thực hiện chưa thành công", tone: "error" },
  canceled: { label: "Đã hủy", tone: "neutral" },
};

export function approvalExecutionPresentation(
  status: ExecutionJobStatus,
  blocker?: unknown,
): ApprovalExecutionPresentation {
  if (status === "waiting_input" && blocker === "dispatch_not_enabled") {
    return { label: "Đã duyệt — chưa bật gửi", tone: "attention" };
  }
  if (status === "waiting_input" && blocker === "release_approval_required") {
    return { label: "Chờ duyệt phát hành", tone: "attention" };
  }
  return PRESENTATION[status];
}
