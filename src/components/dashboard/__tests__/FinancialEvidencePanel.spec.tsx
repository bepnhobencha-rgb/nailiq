import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FinancialEvidencePanel } from "../FinancialEvidencePanel";
import type { FinancialReportDTO } from "@/shared/reports/financialReportDto";

function report(): FinancialReportDTO {
  const unknown = { unit: "operation" as const, state: "unknown" as const, includedRows: 0, excludedRows: 0, reasonCodes: ["external_not_reconciled"], sourceCounts: {} };
  return {
    schemaVersion: 2, reportFingerprint: "a".repeat(64), sourceFingerprint: "b".repeat(64),
    salon: { id: "11111111-1111-4111-8111-111111111111", name: "QA", timezone: "America/Vancouver", currency: "CAD" },
    range: { localFrom: "2026-08-20", localToExclusive: "2026-08-21", utcFrom: "2026-08-20T07:00:00Z", utcToExclusive: "2026-08-21T07:00:00Z", effectiveUtcToExclusive: "2026-08-20T18:00:00Z" },
    generatedAt: "2026-08-20T18:00:00Z", dataAsOf: "2026-08-20T18:00:00Z", basis: "mixed_with_separate_totals",
    coverage: {
      bookingPricing: { unit: "booking", state: "complete", includedRows: 1, excludedRows: 0, reasonCodes: [], sourceCounts: { canonical_individual: 1 } },
      tax: { unit: "booking", basis: "booking_estimate", state: "complete", includedRows: 1, excludedRows: 0, reasonCodes: [], sourceCounts: { canonical_individual: 1 } },
      payments: { ...unknown, reasonCodes: ["service_and_external_payments_not_reconciled"] }, refunds: { ...unknown, reasonCodes: ["external_refunds_not_reconciled"] },
      tips: { unit: "evidence", state: "not_configured", includedRows: 0, excludedRows: 0, reasonCodes: ["authoritative_tip_ingestion_not_configured"], sourceCounts: {} },
      commission: { unit: "evidence", state: "not_configured", includedRows: 0, excludedRows: 0, reasonCodes: ["approved_commission_policy_not_configured"], sourceCounts: {} },
    },
    totals: { bookedSubtotalCents: 10_000, bookedTaxCents: 500, bookedTotalCents: 10_500, collectedGrossCents: 10_500, refundCents: 2_000, collectedNetCents: -2_000, tipCents: null, commissionCents: null },
    bookingRows: [], operationEvents: [], metricEvents: [], metricPolicies: [],
  };
}

describe("FinancialEvidencePanel", () => {
  it("separates estimate/tax/receipt totals and discloses unavailable metrics in Vietnamese", () => {
    const html = renderToStaticMarkup(<FinancialEvidencePanel slug="qa" language="vi" result={{ ok: true, report: report(), exportToken: "signed" }} />);
    expect(html).toContain("Ước tính thuế"); expect(html).toContain("CA$5.00");
    expect(html).toContain("không gồm ngày cuối"); expect(html).toContain("America/Vancouver");
    expect(html).toContain("−CA$20.00"); expect(html).toContain("Không khả dụng");
    expect(html).toContain("Tải CSV"); expect(html).toContain("Tải PDF");
  });

  it("labels verified tips and commission as an estimate rather than payroll", () => {
    const configured = report();
    configured.totals.tipCents = 800;
    configured.totals.commissionCents = 1500;
    configured.coverage.tips = { unit: "evidence", state: "partial", includedRows: 2, excludedRows: 0, reasonCodes: ["tip_sources_not_fully_reconciled"], sourceCounts: { manual_verified: 2 } };
    configured.coverage.commission = { unit: "evidence", state: "partial", includedRows: 2, excludedRows: 0, reasonCodes: ["commission_estimate_not_payroll"], sourceCounts: { policy_calculation: 2 } };
    const html = renderToStaticMarkup(<FinancialEvidencePanel slug="qa" language="vi" result={{ ok: true, report: configured, exportToken: "signed" }} />);
    expect(html).toContain("Tip có bằng chứng");
    expect(html).toContain("CA$8.00");
    expect(html).toContain("Hoa hồng ước tính");
    expect(html).toContain("CA$15.00");
    expect(html).toContain("không phải bảng lương hay lệnh chi trả");
  });
});
