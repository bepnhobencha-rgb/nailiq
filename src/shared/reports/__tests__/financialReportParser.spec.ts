import { describe, expect, it } from "vitest";

import { parseFinancialReportDto } from "../financialReportParser";
import type { FinancialReportDTO } from "../financialReportDto";

function dto(): FinancialReportDTO {
  return {
    schemaVersion: 2, reportFingerprint: null, sourceFingerprint: "a".repeat(64),
    salon: { id: "11111111-1111-4111-8111-111111111111", name: "QA", timezone: "UTC", currency: "CAD" },
    range: {
      localFrom: "2026-08-20", localToExclusive: "2026-08-21",
      utcFrom: "2026-08-20T00:00:00.000Z", utcToExclusive: "2026-08-21T00:00:00.000Z",
      effectiveUtcToExclusive: "2026-08-20T18:00:00.000Z",
    },
    generatedAt: "2026-08-20T18:00:01.000Z", dataAsOf: "2026-08-20T18:00:00.000Z",
    basis: "booking_estimate",
    coverage: {
      bookingPricing: { unit: "booking", state: "complete", includedRows: 1, excludedRows: 0, reasonCodes: [], sourceCounts: { canonical_individual: 1 } },
      tax: { unit: "booking", basis: "booking_estimate", state: "complete", includedRows: 1, excludedRows: 0, reasonCodes: [], sourceCounts: { canonical_individual: 1 } },
      payments: { unit: "operation", state: "unknown", includedRows: 0, excludedRows: 0, reasonCodes: ["service_and_external_payments_not_reconciled"], sourceCounts: {} },
      refunds: { unit: "operation", state: "unknown", includedRows: 0, excludedRows: 0, reasonCodes: ["external_refunds_not_reconciled"], sourceCounts: {} },
      tips: { unit: "evidence", state: "not_configured", includedRows: 0, excludedRows: 0, reasonCodes: ["authoritative_tip_ingestion_not_configured"], sourceCounts: {} },
      commission: { unit: "evidence", state: "not_configured", includedRows: 0, excludedRows: 0, reasonCodes: ["approved_commission_policy_not_configured"], sourceCounts: {} },
    },
    totals: { bookedSubtotalCents: 10_000, bookedTaxCents: 500, bookedTotalCents: 10_500, collectedGrossCents: null, refundCents: null, collectedNetCents: null, tipCents: null, commissionCents: null },
    bookingRows: [{
      rowId: "21111111-1111-4111-8111-111111111111",
      bookingId: "21111111-1111-4111-8111-111111111111", groupId: null,
      isGroupOrganizer: false, occurredAt: "2026-08-20T20:00:00.000Z",
      sourcePath: "canonical_individual", channel: "online",
      staffId: "31111111-1111-4111-8111-111111111111",
      serviceId: "41111111-1111-4111-8111-111111111111", currency: "CAD",
      bookingStatus: "completed", bookedSubtotalCents: 10_000,
      bookedTaxCents: 500, bookedTotalCents: 10_500,
      evidence: { pricingSnapshot: true, pricingFingerprint: "b".repeat(64), pricingSnapshotVersion: 1, coverageReasons: [], groupAggregateParity: null },
    }],
    operationEvents: [], metricEvents: [], metricPolicies: [],
  };
}

describe("financial report strict parser", () => {
  it("keeps future-in-day booking estimates while capping financial evidence at data-as-of", () => {
    expect(parseFinancialReportDto(dto()).bookingRows[0]?.occurredAt)
      .toBe("2026-08-20T20:00:00.000Z");
  });

  it("rejects nonfinal operations carrying fabricated evidenced amounts", () => {
    const value = dto();
    value.operationEvents = [{
      operationId: "51111111-1111-4111-8111-111111111111",
      requestId: "61111111-1111-4111-8111-111111111111",
      bookingId: value.bookingRows[0]!.bookingId, parentOperationId: null,
      occurredAt: "2026-08-20T17:00:00.000Z", kind: "deposit_charge",
      provider: "square", providerAccountFingerprint: "c".repeat(64),
      status: "pending", providerPaymentId: null, providerRefundId: null,
      currency: "CAD", requestedAmountCents: 10_500,
      materialFingerprint: "d".repeat(64), evidencedGrossCents: 10_500,
      evidencedRefundCents: null, evidencedNetCents: 10_500, parentReference: null,
    }];
    value.coverage.payments.excludedRows = 1;
    expect(() => parseFinancialReportDto(value)).toThrow("financial_report_operation_evidence_invalid");
  });

  it("accepts an in-range group member whose organizer is outside the half-open range", () => {
    const value = dto();
    value.bookingRows[0]!.groupId = "71111111-1111-4111-8111-111111111111";
    value.bookingRows[0]!.sourcePath = "canonical_group_member";
    value.bookingRows[0]!.isGroupOrganizer = false;
    value.bookingRows[0]!.evidence.groupAggregateParity = null;
    value.coverage.bookingPricing.sourceCounts = { canonical_group_member: 1 };
    value.coverage.tax.sourceCounts = { canonical_group_member: 1 };
    expect(parseFinancialReportDto(value).bookingRows[0]?.groupId).toBe("71111111-1111-4111-8111-111111111111");
  });
});
