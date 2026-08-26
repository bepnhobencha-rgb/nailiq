import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { renderFinancialReportPdf } from "../financialReportPdf";
import type { FinancialReportDTO } from "../financialReportDto";

function report(): FinancialReportDTO {
  return {
    schemaVersion: 2, reportFingerprint: "a".repeat(64), sourceFingerprint: "b".repeat(64),
    salon: { id: "11111111-1111-4111-8111-111111111111", name: "Thẩm mỹ viện QA", timezone: "UTC", currency: "CAD" },
    range: { localFrom: "2026-08-20", localToExclusive: "2026-08-21", utcFrom: "2026-08-20T00:00:00.000Z", utcToExclusive: "2026-08-21T00:00:00.000Z", effectiveUtcToExclusive: "2026-08-20T18:00:00.000Z" },
    generatedAt: "2026-08-20T18:00:01.000Z", dataAsOf: "2026-08-20T18:00:00.000Z", basis: "booking_estimate",
    coverage: {
      bookingPricing: { unit: "booking", state: "unknown", includedRows: 0, excludedRows: 0, reasonCodes: [], sourceCounts: {} },
      tax: { unit: "booking", basis: "booking_estimate", state: "unknown", includedRows: 0, excludedRows: 0, reasonCodes: [], sourceCounts: {} },
      payments: { unit: "operation", state: "unknown", includedRows: 0, excludedRows: 0, reasonCodes: ["service_and_external_payments_not_reconciled"], sourceCounts: {} },
      refunds: { unit: "operation", state: "unknown", includedRows: 0, excludedRows: 0, reasonCodes: ["external_refunds_not_reconciled"], sourceCounts: {} },
      tips: { unit: "evidence", state: "not_configured", includedRows: 0, excludedRows: 0, reasonCodes: ["tips_policy_not_configured"], sourceCounts: {} },
      commission: { unit: "evidence", state: "not_configured", includedRows: 0, excludedRows: 0, reasonCodes: ["commission_policy_not_configured"], sourceCounts: {} },
    },
    totals: { bookedSubtotalCents: null, bookedTaxCents: null, bookedTotalCents: null, collectedGrossCents: null, refundCents: null, collectedNetCents: null, tipCents: null, commissionCents: null },
    bookingRows: [], operationEvents: [], metricEvents: [], metricPolicies: [],
  };
}

describe("financial report PDF", () => {
  it("renders the immutable fingerprint and exact totals without remote assets", async () => {
    const dto = report();
    const bytes = await renderFinancialReportPdf(dto);
    const source = Buffer.from(bytes).toString("latin1");
    expect(source.startsWith("%PDF-1.7")).toBe(true);
    expect(source).toContain(`Report fingerprint: ${dto.reportFingerprint}`);
    expect(source).toContain("Booked total cents: unavailable");
  });
});
