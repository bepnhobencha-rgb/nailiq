import { describe, expect, it } from "vitest";

import { renderFinancialReportCsv } from "../financialReportCsv";
import type { FinancialReportDTO } from "../financialReportDto";

function report(): FinancialReportDTO {
  return {
    schemaVersion: 2,
    reportFingerprint: "a".repeat(64),
    sourceFingerprint: null,
    salon: { id: "salon-a", name: '\n  =HYPERLINK("https://bad") · Thẩm mỹ viện', timezone: "UTC", currency: "CAD" },
    range: { localFrom: "2026-08-20", localToExclusive: "2026-08-21", utcFrom: "2026-08-20T00:00:00.000Z", utcToExclusive: "2026-08-21T00:00:00.000Z", effectiveUtcToExclusive: "2026-08-21T00:00:00.000Z" },
    generatedAt: "2026-08-20T20:00:00.000Z",
    dataAsOf: "2026-08-20T19:59:59.000Z",
    basis: "mixed_with_separate_totals",
    coverage: {
      bookingPricing: { unit: "booking", state: "complete", includedRows: 1, excludedRows: 0, reasonCodes: [], sourceCounts: { canonical_individual: 1 } },
      tax: { unit: "booking", basis: "booking_estimate", state: "complete", includedRows: 1, excludedRows: 0, reasonCodes: [], sourceCounts: { canonical_individual: 1 } },
      payments: { unit: "operation", state: "partial", includedRows: 1, excludedRows: 0, reasonCodes: ["service_and_external_payments_not_reconciled"], sourceCounts: { deposit_charge: 1 } },
      tips: { unit: "evidence", state: "not_configured", includedRows: 0, excludedRows: 0, reasonCodes: ["tips_policy_not_configured"], sourceCounts: {} },
      refunds: { unit: "operation", state: "unknown", includedRows: 0, excludedRows: 0, reasonCodes: ["external_refunds_not_reconciled"], sourceCounts: {} },
      commission: { unit: "evidence", state: "not_configured", includedRows: 0, excludedRows: 0, reasonCodes: ["commission_policy_not_configured"], sourceCounts: {} },
    },
    totals: { bookedSubtotalCents: 10_000, bookedTaxCents: 500, bookedTotalCents: 10_500, collectedGrossCents: 10_500, tipCents: null, refundCents: null, collectedNetCents: 10_500, commissionCents: null },
    bookingRows: [{
      rowId: "booking-a", bookingId: "booking-a", groupId: null,
      isGroupOrganizer: false, occurredAt: "2026-08-20T17:00:00.000Z",
      sourcePath: "canonical_individual", channel: "online", staffId: null,
      serviceId: "service-a", currency: "CAD", bookingStatus: "completed",
      bookedSubtotalCents: 10_000, bookedTaxCents: 500, bookedTotalCents: 10_500,
      evidence: { pricingSnapshot: true, pricingFingerprint: "b".repeat(64), pricingSnapshotVersion: 1, coverageReasons: [], groupAggregateParity: null },
    }],
    operationEvents: [], metricEvents: [], metricPolicies: [],
  };
}

describe("financial report CSV", () => {
  it("uses RFC 4180 rows, carries the exact fingerprint/totals, and neutralizes formulas", () => {
    const dto = report();
    const csv = renderFinancialReportCsv(dto);
    expect(csv).toContain(`metadata,${dto.reportFingerprint},report`);
    expect(csv).toContain(`total,${dto.reportFingerprint},bookedTotalCents`);
    expect(csv).toContain(`booking,${dto.reportFingerprint}`);
    expect(csv).toContain(`"'\n  =HYPERLINK(""https://bad"") · Thẩm mỹ viện"`);
    expect(csv).toContain(`metadata,${dto.reportFingerprint},booking_row_count`);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("refuses an unsigned or malformed snapshot", () => {
    const dto = report();
    dto.reportFingerprint = null;
    expect(() => renderFinancialReportCsv(dto)).toThrow("financial_report_fingerprint_missing");
  });

  it("preserves null versus zero, negative net, and equal partial refunds as distinct evidence rows", () => {
    const dto = report();
    dto.totals.refundCents = 0; dto.totals.collectedNetCents = -2_000;
    dto.operationEvents = ["one", "two"].map((suffix, index) => ({
      operationId: `${index + 1}1111111-1111-4111-8111-111111111111`,
      requestId: `${index + 3}1111111-1111-4111-8111-111111111111`,
      bookingId: null, parentOperationId: "51111111-1111-4111-8111-111111111111",
      occurredAt: `2026-08-20T1${index + 7}:00:00.000Z`, kind: "deposit_refund" as const,
      provider: "square" as const, providerAccountFingerprint: "c".repeat(64), status: "succeeded" as const,
      providerPaymentId: "payment-parent", providerRefundId: `refund-${suffix}`, currency: "CAD",
      requestedAmountCents: 2_000, materialFingerprint: "d".repeat(64),
      evidencedGrossCents: null, evidencedRefundCents: 2_000, evidencedNetCents: -2_000,
      parentReference: { operationId: "51111111-1111-4111-8111-111111111111", bookingId: null, provider: "square" as const, providerAccountFingerprint: "c".repeat(64), providerPaymentId: "payment-parent", currency: "CAD", requestedAmountCents: 10_500, cumulativeSucceededRefundCents: 4_000 },
    }));
    const csv = renderFinancialReportCsv(dto);
    const refundTotal = csv.split("\r\n").find((line) => line.includes(",refundCents,"))!;
    const tipTotal = csv.split("\r\n").find((line) => line.includes(",tipCents,"))!;
    expect(refundTotal).toContain(",0,"); expect(tipTotal).not.toContain(",0,");
    expect(csv).toContain("refund-one"); expect(csv).toContain("refund-two"); expect(csv).toContain(",-2000,");
  });
});
