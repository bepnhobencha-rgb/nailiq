import type { ExecutionJobStatus } from "@/shared/ai/executionPolicy";
import type { ApprovalDisplayRow } from "@/shared/ai/approvalRequests";
import type { ApprovalExecutionTraceRow } from "@/shared/ai/executionQueue";

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

export type ApprovalDecisionExecutionPresentation =
  ApprovalExecutionPresentation & {
    detail: string;
  };

export function approvalDecisionExecutionPresentation(
  approvalStatus: ApprovalDisplayRow["status"],
  job: ApprovalExecutionTraceRow | undefined,
  language: "en" | "vi",
): ApprovalDecisionExecutionPresentation {
  const vi = language === "vi";
  if (approvalStatus === "declined") {
    return {
      label: vi ? "Không thực thi — đã từ chối" : "Not executed — declined",
      detail: vi
        ? "AI không tạo công việc thực thi cho quyết định này."
        : "AI did not create execution work for this decision.",
      tone: "neutral",
    };
  }
  if (approvalStatus === "expired") {
    return {
      label: vi
        ? "Không thực thi — yêu cầu hết hạn"
        : "Not executed — request expired",
      detail: vi
        ? "Yêu cầu hết hạn mà không cấp quyền thực thi."
        : "The request expired without execution permission.",
      tone: "neutral",
    };
  }
  if (approvalStatus !== "approved") {
    return {
      label: vi ? "Chưa có quyết định" : "No decision yet",
      detail: vi
        ? "AI vẫn đang chờ quyết định."
        : "AI is still waiting for a decision.",
      tone: "attention",
    };
  }
  if (!job) {
    return {
      label: vi
        ? "Không tìm thấy bản ghi thực thi"
        : "Execution record not found",
      detail: vi
        ? "Đã duyệt nhưng chưa thể chứng minh công việc đã được tạo. Hãy kiểm tra trước khi xem là hoàn tất."
        : "Approved, but job creation cannot be proven. Review this before treating it as complete.",
      tone: "error",
    };
  }

  const state = approvalExecutionPresentation(job.status, job.blocker);
  return {
    ...state,
    detail:
      job.attempt_count > 0
        ? vi
          ? `Lần thử ${job.attempt_count}/${job.max_attempts}.`
          : `Attempt ${job.attempt_count}/${job.max_attempts}.`
        : vi
          ? "Chưa bắt đầu lần thực thi đầu tiên."
          : "The first execution attempt has not started.",
  };
}
