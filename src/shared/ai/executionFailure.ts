export const SAFE_EXECUTION_FAILURE_CODES = [
  "execution_transient_failure",
  "stale_execution_lease",
  "tenant_not_operational",
  "worker_lease_expired",
] as const;

export type SafeExecutionFailureCode =
  (typeof SAFE_EXECUTION_FAILURE_CODES)[number];

const SAFE_CODE_SET = new Set<string>(SAFE_EXECUTION_FAILURE_CODES);

export function toSafeExecutionFailureCode(
  error: unknown,
): SafeExecutionFailureCode {
  const candidate =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";

  return SAFE_CODE_SET.has(candidate)
    ? (candidate as SafeExecutionFailureCode)
    : "execution_transient_failure";
}

export function executionFailureLabel(
  code: string,
  language: "en" | "vi",
): string {
  const vi = language === "vi";
  switch (code) {
    case "stale_execution_lease":
      return vi
        ? "Lượt chạy đã được worker mới tiếp quản."
        : "A newer worker attempt has taken over this run.";
    case "tenant_not_operational":
      return vi
        ? "Tiệm hiện không đủ điều kiện để AI thực thi."
        : "The salon is not currently eligible for AI execution.";
    case "worker_lease_expired":
      return vi
        ? "Worker hết thời gian giữ việc; hệ thống sẽ xử lý lại an toàn."
        : "The worker lease expired; the system will recover it safely.";
    default:
      return vi
        ? "Thực thi gặp lỗi tạm thời. Chi tiết kỹ thuật được giữ trong nhật ký bảo mật."
        : "Execution hit a temporary failure. Technical details remain in secure logs.";
  }
}
