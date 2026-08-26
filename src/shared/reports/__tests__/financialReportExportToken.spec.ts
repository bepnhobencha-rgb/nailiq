import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("server-only", () => ({}));

import { signFinancialReportSnapshot, verifyFinancialReportSnapshot } from "../financialReportExportToken";
import type { FinancialReportDTO } from "../financialReportDto";
import { financialReportFingerprintMaterial } from "../financialReportDto";

const NOW = Date.parse("2026-08-20T20:00:00.000Z");

function report(): FinancialReportDTO {
  const value: FinancialReportDTO = {
    schemaVersion: 2,
    reportFingerprint: null,
    sourceFingerprint: null,
    salon: { id: "salon-a", name: "QA", timezone: "UTC", currency: "CAD" },
    range: { localFrom: "2026-08-20", localToExclusive: "2026-08-21", utcFrom: "2026-08-20T00:00:00.000Z", utcToExclusive: "2026-08-21T00:00:00.000Z", effectiveUtcToExclusive: "2026-08-21T00:00:00.000Z" },
    generatedAt: "2026-08-20T19:59:59.000Z", dataAsOf: "2026-08-20T19:59:59.000Z",
    basis: "booking_estimate",
    coverage: {
      bookingPricing: { unit: "booking", state: "unknown", includedRows: 0, excludedRows: 0, reasonCodes: [], sourceCounts: {} },
      tax: { unit: "booking", basis: "booking_estimate", state: "unknown", includedRows: 0, excludedRows: 0, reasonCodes: [], sourceCounts: {} },
      payments: { unit: "operation", state: "unknown", includedRows: 0, excludedRows: 0, reasonCodes: [], sourceCounts: {} },
      tips: { unit: "evidence", state: "not_configured", includedRows: 0, excludedRows: 0, reasonCodes: [], sourceCounts: {} },
      refunds: { unit: "operation", state: "unknown", includedRows: 0, excludedRows: 0, reasonCodes: [], sourceCounts: {} },
      commission: { unit: "evidence", state: "not_configured", includedRows: 0, excludedRows: 0, reasonCodes: [], sourceCounts: {} },
    },
    totals: { bookedSubtotalCents: null, bookedTaxCents: null, bookedTotalCents: null, collectedGrossCents: null, tipCents: null, refundCents: null, collectedNetCents: null, commissionCents: null },
    bookingRows: [], operationEvents: [], metricEvents: [], metricPolicies: [],
  };
  value.reportFingerprint = createHash("sha256")
    .update(financialReportFingerprintMaterial(value), "utf8")
    .digest("hex");
  return value;
}

describe("financial report export token", () => {
  beforeEach(() => vi.stubEnv("FINANCIAL_REPORT_EXPORT_SECRET", "test-secret"));
  afterEach(() => vi.unstubAllEnvs());

  it("binds the exact immutable DTO and actor for a bounded export window", () => {
    const dto = report();
    const token = signFinancialReportSnapshot(dto, "actor-a", NOW);
    expect(verifyFinancialReportSnapshot(dto, "actor-a", token, NOW + 1)).toBe(true);
    expect(verifyFinancialReportSnapshot(dto, "actor-b", token, NOW + 1)).toBe(false);
    dto.totals.bookedTaxCents = 1;
    expect(verifyFinancialReportSnapshot(dto, "actor-a", token, NOW + 1)).toBe(false);
  });

  it("rejects expiration instead of silently reloading a different snapshot", () => {
    const dto = report();
    const token = signFinancialReportSnapshot(dto, "actor-a", NOW);
    expect(verifyFinancialReportSnapshot(dto, "actor-a", token, NOW + 16 * 60 * 1000)).toBe(false);
  });
});
