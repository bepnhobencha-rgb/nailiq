import { salonDayRangeUtc } from "@/shared/lib/salonTime";

export const FINANCIAL_REPORT_SCHEMA_VERSION = 2 as const;

export type FinancialReportBasis =
  | "booking_estimate"
  | "provider_collected"
  | "mixed_with_separate_totals";

export type FinancialCoverageState =
  | "complete"
  | "partial"
  | "unknown"
  | "not_configured";

export type FinancialCoverageMetric =
  | "bookingPricing"
  | "tax"
  | "payments"
  | "tips"
  | "refunds"
  | "commission";

export type FinancialSourcePath =
  | "canonical_individual"
  | "canonical_group_member"
  | "canonical_desk"
  | "canonical_voice"
  | "legacy"
  | "wix_schedule"
  | "square_schedule"
  | "controlled_after_hours"
  | "archived_recovery";

export type FinancialReportRange = {
  localFrom: string;
  localToExclusive: string;
  utcFrom: string;
  utcToExclusive: string;
  effectiveUtcToExclusive: string;
};

export type FinancialCoverage = {
  unit: "booking" | "operation" | "evidence";
  basis?: "booking_estimate";
  state: FinancialCoverageState;
  includedRows: number;
  excludedRows: number;
  reasonCodes: string[];
  sourceCounts: Record<string, number>;
};

export type BookingPricingEvidence = {
  snapshotVersion: number;
  pricingFingerprint: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
};

/**
 * Stage 1 deliberately carries collected gross only. Tips, refunds, net and
 * commission remain unknown until a reconciled provider ledger and approved
 * product semantics exist.
 */
export type FinancialOperationKind =
  | "deposit_charge"
  | "noshow_charge"
  | "late_cancel_charge"
  | "deposit_refund"
  | "noshow_refund"
  | "late_cancel_refund";

export type FinancialOperationStatus =
  | "succeeded"
  | "pending"
  | "unknown"
  | "failed";

/**
 * One immutable ledger operation. A booking may have a charge and multiple
 * partial refunds, so report evidence must never collapse to one receipt per
 * booking.
 */
export type FinancialOperationEvidence = {
  operationId: string;
  requestId: string;
  parentOperationId: string | null;
  bookingId: string | null;
  occurredAt: string;
  kind: FinancialOperationKind;
  provider: "square" | "stripe";
  providerAccountFingerprint: string;
  status: FinancialOperationStatus;
  providerPaymentId: string | null;
  providerRefundId: string | null;
  currency: string;
  requestedAmountCents: number;
  materialFingerprint: string;
  evidencedGrossCents: number | null;
  evidencedRefundCents: number | null;
  evidencedNetCents: number | null;
  /**
   * DB-validated, non-aggregated parent facts for a refund. This keeps a
   * current-period refund verifiable when its charge occurred before the
   * report range, without pulling that old charge into current gross.
   */
  parentReference: null | {
    operationId: string;
    bookingId: string | null;
    provider: "square" | "stripe";
    providerAccountFingerprint: string;
    providerPaymentId: string;
    currency: string;
    requestedAmountCents: number;
    cumulativeSucceededRefundCents: number;
  };
};

export type GroupAggregateParityEvidence = {
  memberBookingIds: string[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
};

export type FinancialReportRow = {
  rowId: string;
  bookingId: string | null;
  groupId: string | null;
  isGroupOrganizer: boolean;
  occurredAt: string;
  sourcePath: FinancialSourcePath;
  channel: string | null;
  staffId: string | null;
  serviceId: string | null;
  currency: string;
  bookingStatus: string | null;
  bookedSubtotalCents: number | null;
  bookedTaxCents: number | null;
  bookedTotalCents: number | null;
  evidence: {
    pricingSnapshot: boolean;
    pricingFingerprint: string | null;
    pricingSnapshotVersion: number | null;
    coverageReasons: string[];
    groupAggregateParity: GroupAggregateParityEvidence | null;
  };
};

export type FinancialReportTotals = {
  bookedSubtotalCents: number | null;
  bookedTaxCents: number | null;
  bookedTotalCents: number | null;
  collectedGrossCents: number | null;
  tipCents: number | null;
  refundCents: number | null;
  collectedNetCents: number | null;
  commissionCents: number | null;
};

export type FinancialReportDTO = {
  schemaVersion: typeof FINANCIAL_REPORT_SCHEMA_VERSION;
  /** Filled by a trusted boundary after hashing `financialReportFingerprintMaterial`. */
  reportFingerprint: string | null;
  /** Immutable fingerprint supplied by the authoritative DB read contract. */
  sourceFingerprint: string | null;
  salon: {
    id: string;
    name: string;
    timezone: string;
    currency: string;
  };
  range: FinancialReportRange;
  generatedAt: string;
  dataAsOf: string;
  basis: FinancialReportBasis;
  coverage: Record<FinancialCoverageMetric, FinancialCoverage>;
  totals: FinancialReportTotals;
  bookingRows: FinancialReportRow[];
  operationEvents: FinancialOperationEvidence[];
  metricEvents: FinancialMetricEvent[];
  metricPolicies: FinancialMetricPolicy[];
};

export type FinancialMetricEvent = {
  evidenceId: string;
  metric: "tips" | "commission";
  bookingId: string;
  paymentOperationId: string | null;
  policyId: string;
  staffId: string | null;
  serviceId: string | null;
  occurredAt: string;
  sourceKind: "provider_receipt" | "manual_verified" | "policy_calculation";
  sourceEventId: string;
  currency: string;
  effect: "credit" | "debit";
  amountCents: number;
  signedAmountCents: number;
  provider: "square" | "stripe" | null;
  providerAccountFingerprint: string | null;
  providerReceiptId: string | null;
  materialFingerprint: string;
};

export type FinancialMetricPolicy = {
  policyId: string;
  metric: "tips" | "commission";
  policyVersion: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  definitionFingerprint: string;
  approvedAt: string;
};

function assertYmd(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`financial_report_invalid_${label}`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() + 1 !== month ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new Error(`financial_report_invalid_${label}`);
  }
}

/**
 * Converts a half-open salon-local date range to half-open UTC bounds. It
 * delegates each local-midnight boundary to the existing DST-safe salonTime
 * helper instead of applying a fixed timezone offset.
 */
export function financialReportRangeFromSalonDates(
  localFrom: string,
  localToExclusive: string,
  timezone: string,
): FinancialReportRange {
  assertYmd(localFrom, "local_from");
  assertYmd(localToExclusive, "local_to_exclusive");
  if (localFrom >= localToExclusive) {
    throw new Error("financial_report_empty_or_reversed_range");
  }

  const utcToExclusive = salonDayRangeUtc(localToExclusive, timezone).startUtc;
  return {
    localFrom,
    localToExclusive,
    utcFrom: salonDayRangeUtc(localFrom, timezone).startUtc,
    utcToExclusive,
    effectiveUtcToExclusive: utcToExclusive,
  };
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a.localeCompare(b);
}

/** Stable order shared by UI/export/fingerprint consumers. */
export function canonicalizeFinancialReportRows(
  rows: readonly FinancialReportRow[],
): FinancialReportRow[] {
  return [...rows].sort(
    (a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) ||
      compareNullable(a.bookingId, b.bookingId) ||
      a.rowId.localeCompare(b.rowId) ||
      a.sourcePath.localeCompare(b.sourcePath),
  );
}

/** Stable ledger order shared by UI/export/fingerprint consumers. */
export function canonicalizeFinancialOperations(
  operations: readonly FinancialOperationEvidence[],
): FinancialOperationEvidence[] {
  return [...operations].sort(
    (a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) ||
      a.operationId.localeCompare(b.operationId) ||
      a.kind.localeCompare(b.kind),
  );
}

/**
 * Returns deterministic currency partitions. A single-currency DTO builder
 * can fail closed while a future caller may render each partition separately.
 */
export function partitionFinancialRowsByCurrency(
  rows: readonly FinancialReportRow[],
): Array<{ currency: string; rows: FinancialReportRow[] }> {
  const groups = new Map<string, FinancialReportRow[]>();
  for (const row of rows) {
    const group = groups.get(row.currency) ?? [];
    group.push(row);
    groups.set(row.currency, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, members]) => ({
      currency,
      rows: canonicalizeFinancialReportRows(members),
    }));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("financial_report_non_finite_fingerprint_value");
  }
  return value;
}

/** Deterministic JSON for equality checks and later trusted hashing. */
export function canonicalFinancialJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

/**
 * Canonical, PII-minimized material for a trusted server boundary to hash.
 * `generatedAt` and `reportFingerprint` are excluded so regenerating an
 * unchanged as-of snapshot produces the same material.
 */
export function financialReportFingerprintMaterial(
  report: FinancialReportDTO,
): string {
  const material = {
    schemaVersion: report.schemaVersion,
    sourceFingerprint: report.sourceFingerprint,
    salon: report.salon,
    range: report.range,
    dataAsOf: report.dataAsOf,
    basis: report.basis,
    coverage: report.coverage,
    totals: report.totals,
    bookingRows: canonicalizeFinancialReportRows(report.bookingRows),
    operationEvents: canonicalizeFinancialOperations(report.operationEvents),
    metricEvents: report.metricEvents,
    metricPolicies: report.metricPolicies,
  };
  return canonicalFinancialJson(material);
}
