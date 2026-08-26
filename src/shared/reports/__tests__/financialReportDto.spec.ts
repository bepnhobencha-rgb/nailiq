import { describe, expect, it } from "vitest";

import {
  FINANCIAL_REPORT_SCHEMA_VERSION,
  canonicalizeFinancialReportRows,
  financialReportFingerprintMaterial,
  financialReportRangeFromSalonDates,
  partitionFinancialRowsByCurrency,
  type FinancialReportDTO,
  type FinancialReportRow,
} from "../financialReportDto";

function row(overrides: Partial<FinancialReportRow> = {}): FinancialReportRow {
  return {
    rowId: "row-a",
    bookingId: "booking-a",
    groupId: null,
    isGroupOrganizer: false,
    occurredAt: "2026-08-20T17:00:00.000Z",
    sourcePath: "canonical_individual",
    channel: "online",
    staffId: "staff-a",
    serviceId: "service-a",
    currency: "CAD",
    bookingStatus: "completed",
    bookedSubtotalCents: 10_000,
    bookedTaxCents: 500,
    bookedTotalCents: 10_500,
    evidence: {
      pricingSnapshot: true,
      pricingFingerprint: "a".repeat(64),
      pricingSnapshotVersion: 1,
      coverageReasons: [
        "provider_collected_evidence_missing",
        "provider_refund_evidence_missing",
      ],
      groupAggregateParity: null,
    },
    ...overrides,
  };
}

function report(rows: FinancialReportRow[], generatedAt = "2026-08-20T18:00:00.000Z"): FinancialReportDTO {
  return {
    schemaVersion: FINANCIAL_REPORT_SCHEMA_VERSION,
    reportFingerprint: null,
    sourceFingerprint: null,
    salon: {
      id: "salon-a",
      name: "QA Salon",
      timezone: "America/Vancouver",
      currency: "CAD",
    },
    range: financialReportRangeFromSalonDates(
      "2026-08-20",
      "2026-08-21",
      "America/Vancouver",
    ),
    generatedAt,
    dataAsOf: "2026-08-20T17:59:00.000Z",
    basis: "booking_estimate",
    coverage: {
      bookingPricing: { unit: "booking", state: "complete", includedRows: rows.length, excludedRows: 0, reasonCodes: [], sourceCounts: { canonical_individual: rows.length } },
      tax: { unit: "booking", basis: "booking_estimate", state: "complete", includedRows: rows.length, excludedRows: 0, reasonCodes: [], sourceCounts: { canonical_individual: rows.length } },
      payments: { unit: "operation", state: "unknown", includedRows: 0, excludedRows: rows.length, reasonCodes: ["provider_collected_evidence_missing"], sourceCounts: { canonical_individual: rows.length } },
      tips: { unit: "evidence", state: "not_configured", includedRows: 0, excludedRows: rows.length, reasonCodes: ["tips_evidence_not_configured"], sourceCounts: { canonical_individual: rows.length } },
      refunds: { unit: "operation", state: "unknown", includedRows: 0, excludedRows: rows.length, reasonCodes: ["provider_refund_evidence_missing"], sourceCounts: { canonical_individual: rows.length } },
      commission: { unit: "evidence", state: "not_configured", includedRows: 0, excludedRows: rows.length, reasonCodes: ["commission_evidence_not_configured"], sourceCounts: { canonical_individual: rows.length } },
    },
    totals: {
      bookedSubtotalCents: 10_000,
      bookedTaxCents: 500,
      bookedTotalCents: 10_500,
      collectedGrossCents: null,
      tipCents: null,
      refundCents: null,
      collectedNetCents: null,
      commissionCents: null,
    },
    bookingRows: rows,
    operationEvents: [],
    metricEvents: [],
    metricPolicies: [],
  };
}

describe("financial report DTO", () => {
  it("uses a versioned schema and half-open salon-local UTC bounds", () => {
    const range = financialReportRangeFromSalonDates(
      "2026-08-20",
      "2026-08-21",
      "America/Vancouver",
    );
    expect(FINANCIAL_REPORT_SCHEMA_VERSION).toBe(2);
    expect(range).toEqual({
      localFrom: "2026-08-20",
      localToExclusive: "2026-08-21",
      utcFrom: "2026-08-20T07:00:00.000Z",
      utcToExclusive: "2026-08-21T07:00:00.000Z",
      effectiveUtcToExclusive: "2026-08-21T07:00:00.000Z",
    });
  });

  it("keeps spring-forward as a 23-hour half-open salon day", () => {
    const range = financialReportRangeFromSalonDates(
      "2026-03-08",
      "2026-03-09",
      "America/Vancouver",
    );
    expect(range.utcFrom).toBe("2026-03-08T08:00:00.000Z");
    expect(range.utcToExclusive).toBe("2026-03-09T07:00:00.000Z");
    expect(Date.parse(range.utcToExclusive) - Date.parse(range.utcFrom)).toBe(23 * 60 * 60 * 1000);
  });

  it("keeps fall-back as a 25-hour half-open salon day", () => {
    const range = financialReportRangeFromSalonDates(
      "2026-11-01",
      "2026-11-02",
      "America/Vancouver",
    );
    expect(range.utcFrom).toBe("2026-11-01T07:00:00.000Z");
    expect(range.utcToExclusive).toBe("2026-11-02T08:00:00.000Z");
    expect(Date.parse(range.utcToExclusive) - Date.parse(range.utcFrom)).toBe(25 * 60 * 60 * 1000);
  });

  it("fails closed on invalid or non-forward local ranges", () => {
    expect(() => financialReportRangeFromSalonDates("2026-02-30", "2026-03-01", "UTC"))
      .toThrow("financial_report_invalid_local_from");
    expect(() => financialReportRangeFromSalonDates("2026-08-20", "2026-08-20", "UTC"))
      .toThrow("financial_report_empty_or_reversed_range");
  });

  it("orders rows deterministically before creating fingerprint material", () => {
    const later = row({ rowId: "row-z", bookingId: "booking-z", occurredAt: "2026-08-20T18:00:00.000Z" });
    const earlier = row({ rowId: "row-a", bookingId: "booking-a", occurredAt: "2026-08-20T16:00:00.000Z" });
    expect(canonicalizeFinancialReportRows([later, earlier]).map((value) => value.rowId))
      .toEqual(["row-a", "row-z"]);

    const first = report([later, earlier]);
    const second = report([earlier, later], "2026-08-20T19:00:00.000Z");
    expect(financialReportFingerprintMaterial(first))
      .toBe(financialReportFingerprintMaterial(second));
    second.dataAsOf = "2026-08-20T18:01:00.000Z";
    expect(financialReportFingerprintMaterial(first))
      .not.toBe(financialReportFingerprintMaterial(second));
  });

  it("partitions mixed currencies deterministically for callers that choose split output", () => {
    const partitions = partitionFinancialRowsByCurrency([
      row({ rowId: "usd", bookingId: "usd", currency: "USD" }),
      row({ rowId: "cad", bookingId: "cad", currency: "CAD" }),
    ]);
    expect(partitions.map((value) => value.currency)).toEqual(["CAD", "USD"]);
    expect(partitions[0]?.rows.map((value) => value.rowId)).toEqual(["cad"]);
  });
});
