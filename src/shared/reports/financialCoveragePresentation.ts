import type { FinancialCoverageMetric, FinancialCoverageState } from "./financialReportDto";

const EN: Record<string, string> = {
  booking_status_not_completed: "Booking was not completed",
  legacy_pricing_unknown: "Legacy booking has no authoritative price snapshot",
  group_aggregate_parity_invalid: "Group pricing could not be reconciled",
  archived_recovery_pricing_unknown: "Recovered booking price is unavailable",
  controlled_after_hours_pricing_unknown: "After-hours price is unavailable",
  wix_schedule_not_financial_truth: "Wix schedule row is not financial evidence",
  square_schedule_not_financial_truth: "Square schedule row is not financial evidence",
  payment_not_final_or_receipt_missing: "Payment is not final or its receipt is missing",
  refund_not_final_or_receipt_missing: "Refund is not final or its receipt is missing",
  refund_parent_invalid: "Refund could not be matched to its original payment",
  service_and_external_payments_not_reconciled: "Service and external payments are not fully reconciled",
  external_refunds_not_reconciled: "External refunds are not fully reconciled",
  authoritative_tip_ingestion_not_configured: "Authoritative tip data is not configured",
  approved_commission_policy_not_configured: "An approved commission policy is not configured",
  tip_evidence_missing: "No verified tip evidence exists in this period",
  tip_sources_not_fully_reconciled: "Tip evidence is recorded, but all external sources are not fully reconciled",
  commission_evidence_missing: "No commission estimate evidence exists in this period",
  commission_estimate_not_payroll: "Commission is an estimate and is not payroll or payout authority",
};
const VI: Record<string, string> = {
  booking_status_not_completed: "Lịch hẹn chưa hoàn tất",
  legacy_pricing_unknown: "Lịch hẹn cũ không có ảnh chụp giá đáng tin cậy",
  group_aggregate_parity_invalid: "Không thể đối chiếu giá của nhóm",
  archived_recovery_pricing_unknown: "Không có giá đáng tin cậy cho lịch hẹn khôi phục",
  controlled_after_hours_pricing_unknown: "Không có giá đáng tin cậy cho lịch ngoài giờ",
  wix_schedule_not_financial_truth: "Dòng lịch Wix không phải bằng chứng tài chính",
  square_schedule_not_financial_truth: "Dòng lịch Square không phải bằng chứng tài chính",
  payment_not_final_or_receipt_missing: "Khoản thu chưa hoàn tất hoặc thiếu biên nhận",
  refund_not_final_or_receipt_missing: "Khoản hoàn chưa hoàn tất hoặc thiếu biên nhận",
  refund_parent_invalid: "Không thể đối chiếu khoản hoàn với khoản thu gốc",
  service_and_external_payments_not_reconciled: "Khoản thu dịch vụ và bên ngoài chưa được đối chiếu đầy đủ",
  external_refunds_not_reconciled: "Khoản hoàn bên ngoài chưa được đối chiếu đầy đủ",
  authoritative_tip_ingestion_not_configured: "Chưa cấu hình nguồn dữ liệu tip đáng tin cậy",
  approved_commission_policy_not_configured: "Chưa cấu hình chính sách hoa hồng được phê duyệt",
  tip_evidence_missing: "Chưa có bằng chứng tip đã xác minh trong kỳ này",
  tip_sources_not_fully_reconciled: "Tip đã có bằng chứng nhưng chưa đối chiếu đầy đủ mọi nguồn bên ngoài",
  commission_evidence_missing: "Chưa có bằng chứng ước tính hoa hồng trong kỳ này",
  commission_estimate_not_payroll: "Hoa hồng chỉ là ước tính, không phải bảng lương hoặc lệnh chi trả",
};

export function financialCoverageReasonLabel(code: string, language: "en" | "vi"): string {
  return (language === "vi" ? VI : EN)[code] ?? code.replaceAll("_", " ");
}
export function financialCoverageMetricLabel(metric: FinancialCoverageMetric, language: "en" | "vi"): string {
  const labels = language === "vi"
    ? { bookingPricing: "Giá lịch hẹn", tax: "Thuế", payments: "Khoản thu", refunds: "Khoản hoàn", tips: "Tip", commission: "Hoa hồng" }
    : { bookingPricing: "Booking pricing", tax: "Tax", payments: "Payments", refunds: "Refunds", tips: "Tips", commission: "Commission" };
  return labels[metric];
}
export function financialCoverageStateLabel(state: FinancialCoverageState, language: "en" | "vi"): string {
  const labels = language === "vi"
    ? { complete: "Đầy đủ", partial: "Một phần", unknown: "Chưa đủ bằng chứng", not_configured: "Không khả dụng" }
    : { complete: "Complete", partial: "Partial", unknown: "Insufficient evidence", not_configured: "Unavailable" };
  return labels[state];
}
