import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildFinancialReport,
  classifyFinancialEvidence,
  type FinancialEvidenceInput,
} from "../financialCoverage";
import {
  FINANCIAL_REPORT_SCHEMA_VERSION,
  financialReportRangeFromSalonDates,
  type FinancialOperationEvidence,
} from "../financialReportDto";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const RANGE = financialReportRangeFromSalonDates(
  "2026-08-20",
  "2026-08-21",
  "America/Vancouver",
);

function evidence(overrides: Partial<FinancialEvidenceInput> = {}): FinancialEvidenceInput {
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
  return {
    operationId: "11111111-1111-4111-8111-111111111111",
    requestId: "21111111-1111-4111-8111-111111111111",
    parentOperationId: null,
    bookingId: "booking-a",
    occurredAt: "2026-08-20T17:05:00.000Z",
    kind: "deposit_charge",
    provider: "square",
    providerAccountFingerprint: "e".repeat(64),
    status: "succeeded",
    providerPaymentId: "payment-a",
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
}

function build(rows: FinancialEvidenceInput[], operationEvents: FinancialOperationEvidence[] = []) {
  return buildFinancialReport({
    salon: {
      id: "salon-a",
      name: "Disposable QA Salon",
      timezone: "America/Vancouver",
      currency: "CAD",
    },
    range: RANGE,
    generatedAt: "2026-08-20T18:00:00.000Z",
    dataAsOf: "2026-08-20T17:59:00.000Z",
    rows,
    operationEvents,
  });
}

describe("MQA-0116..0121 financial report acceptance", () => {
  it("keeps absent money null, preserves evidenced zero, and drops caller PII", () => {
    const raw = evidence({ bookingPricing: null }) as FinancialEvidenceInput & {
      customerName: string;
      customerEmail: string;
      customerPhone: string;
    };
    raw.customerName = "=HYPERLINK(\"https://attacker.invalid\")";
    raw.customerEmail = "person@example.test";
    raw.customerPhone = "+16045550100";

    const missing = classifyFinancialEvidence(raw);
    expect(missing.bookedSubtotalCents).toBeNull();
    expect(missing.bookedTaxCents).toBeNull();
    expect(JSON.stringify(missing)).not.toContain("person@example.test");
    expect(JSON.stringify(missing)).not.toContain("+16045550100");
    expect(JSON.stringify(missing)).not.toContain("HYPERLINK");

    const zero = classifyFinancialEvidence(evidence({
      bookingPricing: {
        snapshotVersion: 1,
        pricingFingerprint: "b".repeat(64),
        subtotalCents: 0,
        taxCents: 0,
        totalCents: 0,
      },
    }));
    expect(zero.bookedTaxCents).toBe(0);
    expect(zero.bookedTotalCents).toBe(0);
  });

  it("counts canonical group member tax exactly once and uses organizer aggregate only for parity", () => {
    const organizer = evidence({
      rowId: "organizer",
      bookingId: "organizer",
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
        memberBookingIds: ["member", "organizer"],
        subtotalCents: 30_000,
        taxCents: 1_500,
        totalCents: 31_500,
      },
    });
    const member = evidence({
      rowId: "member",
      bookingId: "member",
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
  });

  it("accepts only strict final operation receipts and never derives money from booking flags", () => {
    const accepted = build([evidence()], [operation()]).report;
    expect(accepted.totals.collectedGrossCents).toBe(10_500);
    expect(accepted.operationEvents[0]?.providerPaymentId).toBe("payment-a");
    expect(accepted.totals.refundCents).toBeNull();

    expect(() => build([evidence()], [operation({
      status: "unknown",
      evidencedGrossCents: 10_500,
    })])).toThrow("financial_report_operation_evidence_invalid");
    expect(() => build([evidence()], [operation({ providerPaymentId: "" })]))
      .toThrow("financial_report_operation_evidence_invalid");
    expect(() => build([evidence()], [operation({ currency: "USD" })]))
      .toThrow("financial_report_operation_evidence_invalid");
  });

  it("represents one charge plus two equal partial refunds as distinct ordered events", () => {
    const charge = operation();
    const parentReference = {
      operationId: charge.operationId,
      bookingId: charge.bookingId,
      provider: charge.provider,
      providerAccountFingerprint: charge.providerAccountFingerprint,
      providerPaymentId: charge.providerPaymentId!,
      currency: charge.currency,
      requestedAmountCents: charge.requestedAmountCents,
      cumulativeSucceededRefundCents: 4_000,
    };
    const refund = (operationId: string, requestId: string, receiptId: string, occurredAt: string) => operation({
      operationId,
      requestId,
      parentOperationId: charge.operationId,
      occurredAt,
      kind: "deposit_refund",
      providerRefundId: receiptId,
      requestedAmountCents: 2_000,
      evidencedGrossCents: null,
      evidencedRefundCents: 2_000,
      evidencedNetCents: -2_000,
      parentReference,
    });
    const report = build([evidence()], [
      refund("11111111-1111-4111-8111-333333333333", "21111111-1111-4111-8111-333333333333", "refund-receipt-two", "2026-08-20T19:00:00.000Z"),
      charge,
      refund("11111111-1111-4111-8111-222222222222", "21111111-1111-4111-8111-222222222222", "refund-receipt-one", "2026-08-20T18:00:00.000Z"),
    ]).report;
    expect(report.operationEvents.map((event) => event.operationId))
      .toEqual([
        "11111111-1111-4111-8111-111111111111",
        "11111111-1111-4111-8111-222222222222",
        "11111111-1111-4111-8111-333333333333",
      ]);
    expect(report.totals).toMatchObject({
      bookedTotalCents: 10_500,
      collectedGrossCents: 10_500,
      refundCents: 4_000,
      collectedNetCents: 6_500,
    });
  });

  it("keeps tips and commission explicitly unavailable without approved evidence and policy", () => {
    const injected = evidence() as FinancialEvidenceInput & {
      tipCents: number;
      commissionCents: number;
      commissionRate: number;
    };
    injected.tipCents = 2_000;
    injected.commissionCents = 3_000;
    injected.commissionRate = 0.3;

    const { report } = build([injected]);
    expect(report.totals.tipCents).toBeNull();
    expect(report.totals.commissionCents).toBeNull();
    expect(report.coverage.tips).toMatchObject({ state: "not_configured", includedRows: 0 });
    expect(report.coverage.commission).toMatchObject({ state: "not_configured", includedRows: 0 });
  });

  it("fails closed on mixed currencies and uses DST-correct half-open salon-local bounds", () => {
    expect(() => build([
      evidence(),
      evidence({ rowId: "usd", bookingId: "usd", currency: "USD" }),
    ])).toThrow("financial_report_mixed_currency");

    const spring = financialReportRangeFromSalonDates(
      "2026-03-08",
      "2026-03-09",
      "America/Vancouver",
    );
    const fall = financialReportRangeFromSalonDates(
      "2026-11-01",
      "2026-11-02",
      "America/Vancouver",
    );
    expect(Date.parse(spring.utcToExclusive) - Date.parse(spring.utcFrom)).toBe(23 * 60 * 60 * 1000);
    expect(Date.parse(fall.utcToExclusive) - Date.parse(fall.utcFrom)).toBe(25 * 60 * 60 * 1000);
  });

  it("keeps deterministic DTO/fingerprint material independent of source row order", () => {
    const first = evidence({ rowId: "first", bookingId: "first", occurredAt: "2026-08-20T16:00:00.000Z" });
    const second = evidence({ rowId: "second", bookingId: "second", occurredAt: "2026-08-20T17:00:00.000Z" });
    const forward = build([first, second]);
    const reverse = build([second, first]);
    expect(forward.report.schemaVersion).toBe(FINANCIAL_REPORT_SCHEMA_VERSION);
    expect(forward.report.bookingRows.map((row) => row.rowId)).toEqual(["first", "second"]);
    expect(reverse.fingerprintMaterial).toBe(forward.fingerprintMaterial);
  });

  it("keeps provider payment/refund receipts tenant-bound and non-public at the DB contract", () => {
    const migration = read("supabase/migrations/20260820150000_add_authoritative_booking_payment_operations.sql");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.booking_payment_operations");
    expect(migration).toMatch(/provider_account_fingerprint\s+text/);
    expect(migration).toMatch(/provider_payment_id\s+text/);
    expect(migration).toMatch(/provider_refund_id\s+text/);
    expect(migration).toMatch(/booking_payment_operations_payment_receipt_once[\s\S]{0,180}provider_account_fingerprint[\s\S]{0,120}provider_payment_id/);
    expect(migration).toMatch(/booking_payment_operations_refund_receipt_once[\s\S]{0,180}provider_account_fingerprint[\s\S]{0,120}provider_refund_id/);
    expect(migration).toMatch(/REVOKE ALL ON TABLE public\.booking_payment_operations FROM PUBLIC, anon, authenticated/);
    expect(migration).toMatch(/GRANT SELECT, INSERT, UPDATE ON TABLE public\.booking_payment_operations TO service_role/);
  });

  it("labels the current dashboard value as an estimate and disclaims financial totals", () => {
    const english = read("src/shared/i18n/user/en.ts");
    const vietnamese = read("src/shared/i18n/user/vi.ts");
    expect(english).toContain('totalRevenue: "Estimated completed service value"');
    expect(english).toContain("not collected-payment, tax, tip, commission, or refund totals");
    expect(vietnamese).toContain('totalRevenue: "Giá trị dịch vụ hoàn tất ước tính"');
  });

});
