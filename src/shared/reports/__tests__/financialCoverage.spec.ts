import { describe, expect, it } from "vitest";

import {
  buildFinancialReport,
  classifyFinancialEvidence,
  type FinancialEvidenceInput,
} from "../financialCoverage";
import {
  financialReportRangeFromSalonDates,
  type FinancialOperationEvidence,
  type FinancialSourcePath,
} from "../financialReportDto";

const RANGE = financialReportRangeFromSalonDates(
  "2026-08-20",
  "2026-08-21",
  "America/Vancouver",
);

function input(overrides: Partial<FinancialEvidenceInput> = {}): FinancialEvidenceInput {
  return {
    rowId: "booking-a",
    bookingId: "booking-a",
    occurredAt: "2026-08-20T17:00:00.000Z",
    sourcePath: "canonical_individual",
    currency: "CAD",
    bookingPricing: {
      snapshotVersion: 1,
      pricingFingerprint: "a".repeat(64),
      subtotalCents: 10_000,
      taxCents: 500,
      totalCents: 10_500,
    },
    ...overrides,
  };
}

function operation(overrides: Partial<FinancialOperationEvidence> = {}): FinancialOperationEvidence {
  const merged: FinancialOperationEvidence = {
    operationId: "11111111-1111-4111-8111-111111111111",
    requestId: "21111111-1111-4111-8111-111111111111",
    parentOperationId: null,
    bookingId: "booking-a",
    occurredAt: "2026-08-20T17:05:00.000Z",
    kind: "deposit_charge" as const,
    provider: "square" as const,
    providerAccountFingerprint: "e".repeat(64),
    status: "succeeded" as const,
    providerPaymentId: "square-payment-1",
    providerRefundId: null,
    currency: "CAD",
    requestedAmountCents: 10_500,
    materialFingerprint: "f".repeat(64),
    evidencedGrossCents: 10_500,
    evidencedRefundCents: null,
    evidencedNetCents: 10_500,
    parentReference: null,
    ...overrides,
  };
  return merged;
}

function build(
  rows: FinancialEvidenceInput[],
  currency = "CAD",
  operationEvents: FinancialOperationEvidence[] = [],
) {
  return buildFinancialReport({
    salon: {
      id: "salon-a",
      name: "QA Salon",
      timezone: "America/Vancouver",
      currency,
    },
    range: RANGE,
    generatedAt: "2026-08-20T18:00:00.000Z",
    dataAsOf: "2026-08-20T17:59:00.000Z",
    rows,
    operationEvents,
  });
}

describe("financial evidence classification", () => {
  it("keeps missing financial evidence null rather than inventing zero", () => {
    const withoutEvidence = classifyFinancialEvidence(input({ bookingPricing: null }));
    expect(withoutEvidence.bookedSubtotalCents).toBeNull();
    expect(withoutEvidence.bookedTaxCents).toBeNull();
    expect(withoutEvidence.bookedTotalCents).toBeNull();

    const evidencedZero = classifyFinancialEvidence(input({
      bookingPricing: {
        snapshotVersion: 1,
        pricingFingerprint: "b".repeat(64),
        subtotalCents: 0,
        taxCents: 0,
        totalCents: 0,
      },
    }));
    expect(evidencedZero.bookedTotalCents).toBe(0);
  });

  it.each([
    ["legacy", "legacy_pricing_unknown"],
    ["wix_schedule", "wix_schedule_not_financial_truth"],
    ["square_schedule", "square_schedule_not_financial_truth"],
    ["controlled_after_hours", "controlled_after_hours_pricing_unknown"],
    ["archived_recovery", "archived_recovery_pricing_unknown"],
  ] satisfies Array<[FinancialSourcePath, string]>) (
    "classifies %s pricing as unknown even when a caller supplies amounts",
    (sourcePath, reason) => {
      const classified = classifyFinancialEvidence(input({ sourcePath }));
      expect(classified.bookedTotalCents).toBeNull();
      expect(classified.evidence.pricingSnapshot).toBe(false);
      expect(classified.evidence.coverageReasons).toContain(reason);
    },
  );

  it("keeps booking estimates and provider-collected gross in separate totals", () => {
    const { report } = build([input()], "CAD", [operation({
      requestedAmountCents: 13_000,
      evidencedGrossCents: 13_000,
      evidencedNetCents: 13_000,
    })]);
    expect(report.basis).toBe("mixed_with_separate_totals");
    expect(report.totals.bookedTotalCents).toBe(10_500);
    expect(report.totals.collectedGrossCents).toBe(13_000);
    expect(report.totals).not.toHaveProperty("revenueCents");
    expect(report.totals.tipCents).toBeNull();
    expect(report.totals.refundCents).toBeNull();
    expect(report.totals.collectedNetCents).toBe(13_000);
    expect(report.totals.commissionCents).toBeNull();
  });

  it("keeps a provider-only row from fabricating a booking estimate or net amount", () => {
    const { report } = build([input({
      bookingId: null,
      sourcePath: "legacy",
      bookingPricing: null,
    })], "CAD", [operation({
      bookingId: null,
      provider: "stripe",
      providerPaymentId: "stripe-payment-1",
      requestedAmountCents: 8_000,
      evidencedGrossCents: 8_000,
      evidencedNetCents: 8_000,
    })]);
    expect(report.basis).toBe("provider_collected");
    expect(report.totals.bookedTotalCents).toBeNull();
    expect(report.totals.collectedGrossCents).toBe(8_000);
    expect(report.totals.collectedNetCents).toBe(8_000);
  });

  it("rejects duplicate provider receipts across different report rows", () => {
    expect(() => build([
      input(),
      input({
        rowId: "booking-b",
        bookingId: "booking-b",
      }),
    ], "CAD", [
      operation({ providerPaymentId: "same-payment" }),
      operation({ operationId: "11111111-1111-4111-8111-222222222222", requestId: "21111111-1111-4111-8111-222222222222", bookingId: "booking-b", providerPaymentId: "same-payment" }),
    ])).toThrow("financial_report_duplicate_provider_receipt");
  });

  it("does not accept canonical pricing without a durable booking identity", () => {
    const classified = classifyFinancialEvidence(input({ bookingId: null }));
    expect(classified.bookedTotalCents).toBeNull();
    expect(classified.evidence.coverageReasons).toContain("canonical_booking_id_missing");
  });

  it("counts each canonical group member once and uses organizer aggregate only for parity", () => {
    const organizer = input({
      rowId: "booking-organizer",
      bookingId: "booking-organizer",
      groupId: "group-a",
      isGroupOrganizer: true,
      sourcePath: "canonical_group_member",
      bookingPricing: {
        snapshotVersion: 1,
        pricingFingerprint: "c".repeat(64),
        subtotalCents: 12_000,
        taxCents: 600,
        totalCents: 12_600,
      },
      groupAggregateParity: {
        memberBookingIds: ["booking-member", "booking-organizer"],
        subtotalCents: 30_000,
        taxCents: 1_500,
        totalCents: 31_500,
      },
    });
    const member = input({
      rowId: "booking-member",
      bookingId: "booking-member",
      groupId: "group-a",
      sourcePath: "canonical_group_member",
      bookingPricing: {
        snapshotVersion: 1,
        pricingFingerprint: "d".repeat(64),
        subtotalCents: 18_000,
        taxCents: 900,
        totalCents: 18_900,
      },
    });

    const { report } = build([member, organizer, organizer]);
    expect(report.bookingRows).toHaveLength(2);
    expect(report.totals).toMatchObject({
      bookedSubtotalCents: 30_000,
      bookedTaxCents: 1_500,
      bookedTotalCents: 31_500,
    });
    expect(report.bookingRows.find((row) => row.isGroupOrganizer)?.evidence.groupAggregateParity)
      .toMatchObject({ totalCents: 31_500 });
  });

  it("fails closed when organizer aggregate does not match exact member rows", () => {
    const organizer = input({
      rowId: "organizer",
      bookingId: "organizer",
      groupId: "group-a",
      isGroupOrganizer: true,
      sourcePath: "canonical_group_member",
      groupAggregateParity: {
        memberBookingIds: ["member", "organizer"],
        subtotalCents: 20_001,
        taxCents: 999,
        totalCents: 21_000,
      },
    });
    const member = input({
      rowId: "member",
      bookingId: "member",
      groupId: "group-a",
      sourcePath: "canonical_group_member",
    });
    expect(() => build([organizer, member])).toThrow("financial_report_group_aggregate_mismatch");
  });

  it("reports partial canonical coverage without converting unknown rows to zero", () => {
    const { report } = build([
      input(),
      input({ rowId: "legacy", bookingId: "legacy", sourcePath: "legacy" }),
    ]);
    expect(report.coverage.bookingPricing).toMatchObject({
      state: "partial",
      includedRows: 1,
      excludedRows: 1,
    });
    expect(report.coverage.bookingPricing.reasonCodes).toContain("legacy_pricing_unknown");
    expect(report.bookingRows.find((row) => row.rowId === "legacy")?.bookedTotalCents).toBeNull();
    expect(report.totals.bookedTotalCents).toBe(10_500);
  });

  it("fails closed on mixed currencies while preserving a partition helper in the DTO layer", () => {
    expect(() => build([
      input(),
      input({ rowId: "usd", bookingId: "usd", currency: "USD" }),
    ])).toThrow("financial_report_mixed_currency");
  });

  it("produces deterministic rows and fingerprint material for reordered inputs", () => {
    const first = input({ rowId: "first", bookingId: "first", occurredAt: "2026-08-20T16:00:00.000Z" });
    const second = input({ rowId: "second", bookingId: "second", occurredAt: "2026-08-20T17:00:00.000Z" });
    const forward = build([first, second]);
    const reverse = build([second, first]);
    expect(forward.report.bookingRows.map((row) => row.rowId)).toEqual(["first", "second"]);
    expect(reverse.report.bookingRows.map((row) => row.rowId)).toEqual(["first", "second"]);
    expect(forward.fingerprintMaterial).toBe(reverse.fingerprintMaterial);
    expect(forward.report.schemaVersion).toBe(2);
  });

  it("preserves ordered charge plus multiple partial refunds without double-counting", () => {
    const charge = operation();
    const parentReference = {
      operationId: charge.operationId,
      bookingId: charge.bookingId,
      provider: charge.provider,
      providerAccountFingerprint: charge.providerAccountFingerprint,
      providerPaymentId: charge.providerPaymentId!,
      currency: charge.currency,
      requestedAmountCents: charge.requestedAmountCents,
      cumulativeSucceededRefundCents: 3_500,
    };
    const { report } = build([input()], "CAD", [
        charge,
        operation({
          operationId: "11111111-1111-4111-8111-333333333333",
          requestId: "21111111-1111-4111-8111-333333333333",
          parentOperationId: charge.operationId,
          occurredAt: "2026-08-20T19:00:00.000Z",
          kind: "deposit_refund",
          providerRefundId: "refund-2-receipt",
          requestedAmountCents: 1_500,
          evidencedGrossCents: null,
          evidencedRefundCents: 1_500,
          evidencedNetCents: -1_500,
          parentReference,
        }),
        operation({
          operationId: "11111111-1111-4111-8111-222222222222",
          requestId: "21111111-1111-4111-8111-222222222222",
          parentOperationId: charge.operationId,
          occurredAt: "2026-08-20T18:00:00.000Z",
          kind: "deposit_refund",
          providerRefundId: "refund-1-receipt",
          requestedAmountCents: 2_000,
          evidencedGrossCents: null,
          evidencedRefundCents: 2_000,
          evidencedNetCents: -2_000,
          parentReference,
        }),
      ]);

    expect(report.operationEvents.map((value) => value.operationId))
      .toEqual([
        "11111111-1111-4111-8111-111111111111",
        "11111111-1111-4111-8111-222222222222",
        "11111111-1111-4111-8111-333333333333",
      ]);
    expect(report.totals).toMatchObject({
      collectedGrossCents: 10_500,
      refundCents: 3_500,
      collectedNetCents: 7_000,
    });
    expect(report.coverage.refunds).toMatchObject({
      state: "partial",
      reasonCodes: ["external_refunds_not_reconciled"],
    });
  });

  it("reports an in-period refund without pulling its prior-period charge into gross", () => {
    const parentReference = {
      operationId: "11111111-1111-4111-8111-444444444444",
      bookingId: "prior-booking",
      provider: "square" as const,
      providerAccountFingerprint: "e".repeat(64),
      providerPaymentId: "prior-payment",
      currency: "CAD",
      requestedAmountCents: 10_500,
      cumulativeSucceededRefundCents: 2_000,
    };
    const refund = operation({
      operationId: "11111111-1111-4111-8111-555555555555",
      requestId: "21111111-1111-4111-8111-555555555555",
      bookingId: "prior-booking",
      parentOperationId: parentReference.operationId,
      kind: "deposit_refund",
      providerPaymentId: "prior-payment",
      providerRefundId: "current-refund-receipt",
      requestedAmountCents: 2_000,
      evidencedGrossCents: null,
      evidencedRefundCents: 2_000,
      evidencedNetCents: -2_000,
      parentReference,
    });
    const { report } = build([], "CAD", [refund]);
    expect(report.totals.collectedGrossCents).toBeNull();
    expect(report.totals.refundCents).toBe(2_000);
    expect(report.totals.collectedNetCents).toBe(-2_000);
    expect(report.basis).toBe("provider_collected");
  });
});
