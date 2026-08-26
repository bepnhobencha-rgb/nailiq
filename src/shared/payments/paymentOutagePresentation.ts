const RECONCILIATION_CODES = new Set([
  "deposit_pending",
  "provider_outcome_unknown",
  "completion_write_uncertain",
  "pending_provider",
  "processing",
  "requires_capture",
  "unknown",
  "in_flight",
  "finalization_not_available",
  "payment_reconciliation_required",
]);

export function isPaymentReconciliationCode(code: unknown): boolean {
  return typeof code === "string" && RECONCILIATION_CODES.has(code);
}

export function publicDepositFailureMessage(
  code: unknown,
  copy?: { error?: string; pending?: string },
): string {
  if (isPaymentReconciliationCode(code)) {
    return copy?.pending ??
      "Your payment result is being verified. Do not pay again. Check the same payment status shortly. · Kết quả thanh toán đang được đối soát. Không thanh toán lại; vui lòng kiểm tra lại đúng giao dịch này sau ít phút.";
  }
  return copy?.error ?? "Payment not completed. Please try again.";
}

export function isCommittedCancellationPaymentPending(value: {
  ok?: boolean;
  code?: string;
  bookingCommitted?: boolean;
  feeStatus?: string;
}): boolean {
  return value.ok !== true && value.bookingCommitted === true &&
    value.code === "payment_reconciliation_required" &&
    (value.feeStatus === "pending_provider" || value.feeStatus === "unknown");
}

export function deskRefundOutcomeMessage(
  status: "pending_provider" | "unknown" | "definite_failure",
  error?: string,
): string {
  if (status === "definite_failure") {
    return `Đã huỷ. Hoàn cọc bị từ chối (${error ?? "lỗi"}); cần kiểm tra trước khi thử lại.`;
  }
  const truth = status === "pending_provider" ? "nhà cung cấp đang xử lý" : "chưa xác định";
  return `Đã huỷ. Kết quả hoàn cọc ${truth}; đang đối soát và không tạo yêu cầu hoàn mới.`;
}
