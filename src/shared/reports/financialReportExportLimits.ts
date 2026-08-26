import { canonicalFinancialJson, type FinancialReportDTO } from "./financialReportDto";

export const MAX_FINANCIAL_REPORT_RECORDS = 700;
export const MAX_FINANCIAL_REPORT_CANONICAL_BYTES = 3 * 1024 * 1024;

/** One shared UI/CSV/PDF eligibility boundary, evaluated before signing. */
export function assertFinancialReportExportable(report: FinancialReportDTO): void {
  const records = report.bookingRows.length + report.operationEvents.length + report.metricEvents.length + report.metricPolicies.length;
  if (records > MAX_FINANCIAL_REPORT_RECORDS) throw new Error("financial_report_too_large");
  if (new TextEncoder().encode(canonicalFinancialJson(report)).byteLength > MAX_FINANCIAL_REPORT_CANONICAL_BYTES) {
    throw new Error("financial_report_too_large");
  }
}
