export const SAFE_EXECUTION_FAILURE_CODES = [
  "execution_transient_failure",
  "stale_execution_lease",
  "tenant_not_operational",
  "worker_lease_expired",
] as const;

export type SafeExecutionFailureCode =
  (typeof SAFE_EXECUTION_FAILURE_CODES)[number];

const SAFE_CODE_SET = new Set<string>(SAFE_EXECUTION_FAILURE_CODES);
const SAFE_WORKER_FAILURE_CODES = new Set([
  ...SAFE_EXECUTION_FAILURE_CODES,
  "cron_heartbeat_unavailable",
  "execution_worker_failed",
  "handler_exception",
  "manager_agent_failures",
  "manager_heartbeat_unavailable",
  "salon_load_failed",
]);
const SAFE_HTTP_FAILURE = /^http_[45]\d{2}$/;

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

export function toSafeWorkerFailureCode(error: unknown): string | null {
  if (error == null || error === "") return null;
  const candidate =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";

  if (
    SAFE_WORKER_FAILURE_CODES.has(candidate) ||
    SAFE_HTTP_FAILURE.test(candidate)
  ) {
    return candidate;
  }
  return "execution_worker_failed";
}

export function workerFailureLabel(
  code: string,
  language: "en" | "vi",
): string {
  const vi = language === "vi";
  switch (code) {
    case "manager_agent_failures":
      return vi
        ? "Một hoặc nhiều agent không hoàn tất; xem ngoại lệ vận hành."
        : "One or more agents did not complete; review operating exceptions.";
    case "salon_load_failed":
      return vi
        ? "AI Manager chưa tải được danh sách tiệm."
        : "AI Manager could not load the salon list.";
    case "handler_exception":
      return vi
        ? "Tác vụ định kỳ gặp lỗi nội bộ."
        : "The scheduled task hit an internal failure.";
    case "stale_execution_lease":
    case "tenant_not_operational":
    case "worker_lease_expired":
      return executionFailureLabel(code, language);
    default:
      return vi
        ? "Worker gặp lỗi vận hành; chi tiết kỹ thuật được giữ trong nhật ký bảo mật."
        : "The worker hit an operating failure; technical details remain in secure logs.";
  }
}
