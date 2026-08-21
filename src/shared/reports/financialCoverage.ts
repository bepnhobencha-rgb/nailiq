import {
  FINANCIAL_REPORT_SCHEMA_VERSION,
  canonicalFinancialJson,
  canonicalizeFinancialReportRows,
  financialReportFingerprintMaterial,
  partitionFinancialRowsByCurrency,
  type BookingPricingEvidence,
  type FinancialCoverage,
  type FinancialCoverageMetric,
  type FinancialReportDTO,
  type FinancialReportRange,
  type FinancialReportRow,
  type FinancialSourcePath,
  type GroupAggregateParityEvidence,
  type FinancialOperationEvidence,
} from "./financialReportDto";

const CANONICAL_PRICING_SOURCES = new Set<FinancialSourcePath>([
  "canonical_individual",
  "canonical_group_member",
  "canonical_desk",
  "canonical_voice",
]);

const SOURCE_REASON: Partial<Record<FinancialSourcePath, string>> = {
  legacy: "legacy_pricing_unknown",
  wix_schedule: "wix_schedule_not_financial_truth",
  square_schedule: "square_schedule_not_financial_truth",
  controlled_after_hours: "controlled_after_hours_pricing_unknown",
  archived_recovery: "archived_recovery_pricing_unknown",
};

export type FinancialEvidenceInput = {
  rowId: string;
  bookingId: string | null;
  groupId?: string | null;
  isGroupOrganizer?: boolean;
  occurredAt: string;
  sourcePath: FinancialSourcePath;
  channel?: string | null;
  staffId?: string | null;
  serviceId?: string | null;
  currency: string;
  bookingStatus?: string | null;
  bookingPricing?: BookingPricingEvidence | null;
  groupAggregateParity?: GroupAggregateParityEvidence | null;
};

export type BuildFinancialReportInput = {
  salon: FinancialReportDTO["salon"];
  range: FinancialReportRange;
  generatedAt: string;
  dataAsOf: string;
  rows: readonly FinancialEvidenceInput[];
  operationEvents?: readonly FinancialOperationEvidence[];
};

export type BuiltFinancialReport = {
  report: FinancialReportDTO;
  fingerprintMaterial: string;
};

function nonblank(value: string): boolean {
  return value.trim().length > 0;
}

function validIso(value: string): boolean {
  return nonblank(value) && !Number.isNaN(Date.parse(value));
}

function safeCents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validCurrency(value: string): boolean {
  return /^[A-Z]{3}$/.test(value);
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validPricing(value: BookingPricingEvidence | null | undefined): value is BookingPricingEvidence {
  return Boolean(
    value &&
      Number.isSafeInteger(value.snapshotVersion) &&
      value.snapshotVersion > 0 &&
      /^[0-9a-f]{64}$/.test(value.pricingFingerprint) &&
      safeCents(value.subtotalCents) &&
      safeCents(value.taxCents) &&
      safeCents(value.totalCents) &&
      value.subtotalCents + value.taxCents === value.totalCents,
  );
}

const CHARGE_KINDS = new Set(["deposit_charge", "noshow_charge", "late_cancel_charge"]);
const REFUND_KINDS = new Set(["deposit_refund", "noshow_refund", "late_cancel_refund"]);

function validOperation(
  value: FinancialOperationEvidence,
  rowCurrency: string,
): boolean {
  const isKnownKind = CHARGE_KINDS.has(value.kind) || REFUND_KINDS.has(value.kind);
  const isCharge = CHARGE_KINDS.has(value.kind);
  const receiptIsValid = value.status !== "succeeded"
    ? true
    : isCharge
      ? Boolean(value.providerPaymentId?.trim()) && value.providerRefundId === null
      : Boolean(value.providerPaymentId?.trim()) && Boolean(value.providerRefundId?.trim());
  const evidencedShapeValid = value.status !== "succeeded"
    ? value.evidencedGrossCents === null &&
      value.evidencedRefundCents === null &&
      value.evidencedNetCents === null
    : isCharge
      ? value.evidencedGrossCents === value.requestedAmountCents &&
        value.evidencedRefundCents === null &&
        value.evidencedNetCents === value.requestedAmountCents
      : value.evidencedGrossCents === null &&
        value.evidencedRefundCents === value.requestedAmountCents &&
        value.evidencedNetCents === -value.requestedAmountCents;
  return Boolean(
    nonblank(value.operationId) &&
      validUuid(value.operationId) &&
      validUuid(value.requestId) &&
      validIso(value.occurredAt) &&
      isKnownKind &&
      (value.provider === "square" || value.provider === "stripe") &&
      /^[0-9a-f]{64}$/.test(value.providerAccountFingerprint) &&
      ["succeeded", "pending", "unknown", "failed"].includes(value.status) &&
      receiptIsValid &&
      evidencedShapeValid &&
      value.currency === rowCurrency &&
      validCurrency(value.currency) &&
      safeCents(value.requestedAmountCents) &&
      value.requestedAmountCents > 0 &&
      /^[0-9a-f]{64}$/.test(value.materialFingerprint) &&
      [value.evidencedGrossCents, value.evidencedRefundCents]
        .every((amount) => amount === null || safeCents(amount)) &&
      (value.evidencedNetCents === null || Number.isSafeInteger(value.evidencedNetCents)) &&
      (isCharge
        ? value.parentOperationId === null && value.parentReference === null
        : Boolean(
          value.parentOperationId &&
          value.parentReference &&
          value.parentReference.operationId === value.parentOperationId &&
          value.parentReference.bookingId === value.bookingId &&
          value.parentReference.provider === value.provider &&
          value.parentReference.providerAccountFingerprint === value.providerAccountFingerprint &&
          value.parentReference.providerPaymentId === value.providerPaymentId &&
          value.parentReference.currency === value.currency &&
          safeCents(value.parentReference.requestedAmountCents) &&
          value.parentReference.requestedAmountCents > 0 &&
          safeCents(value.parentReference.cumulativeSucceededRefundCents) &&
          value.parentReference.cumulativeSucceededRefundCents <= value.parentReference.requestedAmountCents
        )),
  );
}

function sumOperations(
  operations: readonly FinancialOperationEvidence[],
  key: "evidencedGrossCents" | "evidencedRefundCents" | "evidencedNetCents",
): number | null {
  const values = operations
    .filter((operation) => operation.status === "succeeded" && operation[key] !== null)
    .map((operation) => operation[key] as number);
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new Error("financial_report_amount_overflow");
  return total;
}

function normalizedAggregate(
  value: GroupAggregateParityEvidence | null | undefined,
): GroupAggregateParityEvidence | null {
  if (!value) return null;
  const ids = [...new Set(value.memberBookingIds.filter(nonblank))].sort();
  if (
    ids.length !== value.memberBookingIds.length ||
    !safeCents(value.subtotalCents) ||
    !safeCents(value.taxCents) ||
    !safeCents(value.totalCents) ||
    value.subtotalCents + value.taxCents !== value.totalCents
  ) {
    return null;
  }
  return { ...value, memberBookingIds: ids };
}

/**
 * Classifies one row without querying or mutating state. Unsupported schedule
 * and legacy sources never inherit a caller-supplied price as authoritative.
 */
export function classifyFinancialEvidence(input: FinancialEvidenceInput): FinancialReportRow {
  if (!nonblank(input.rowId) || !validIso(input.occurredAt)) {
    throw new Error("financial_report_invalid_row_identity");
  }
  if (!validCurrency(input.currency)) {
    throw new Error("financial_report_invalid_currency");
  }

  const reasons: string[] = [];
  const sourceIsCanonical = CANONICAL_PRICING_SOURCES.has(input.sourcePath);
  const pricingIsValid = validPricing(input.bookingPricing);
  const canonicalIdentityValid =
    !sourceIsCanonical ||
    Boolean(input.bookingId && (input.sourcePath !== "canonical_group_member" || input.groupId));
  const acceptedPricing =
    sourceIsCanonical && canonicalIdentityValid && validPricing(input.bookingPricing)
      ? input.bookingPricing
      : null;
  if (!sourceIsCanonical) {
    reasons.push(SOURCE_REASON[input.sourcePath] ?? "unsupported_pricing_source");
  } else if (!pricingIsValid) {
    reasons.push("canonical_pricing_evidence_missing_or_invalid");
  }

  if (sourceIsCanonical && !input.bookingId) {
    reasons.push("canonical_booking_id_missing");
  }
  if (input.sourcePath === "canonical_group_member" && !input.groupId) {
    reasons.push("group_member_identity_missing");
  }

  reasons.push("provider_collected_evidence_separate_event_range");

  const aggregate = normalizedAggregate(input.groupAggregateParity);
  if (input.groupAggregateParity && !aggregate) {
    reasons.push("group_aggregate_parity_evidence_invalid");
  }
  if (aggregate && input.sourcePath !== "canonical_group_member") {
    reasons.push("group_aggregate_on_non_group_row");
  }
  if (aggregate && !input.isGroupOrganizer) {
    reasons.push("group_aggregate_on_non_organizer");
  }

  return {
    rowId: input.rowId,
    bookingId: input.bookingId,
    groupId: input.groupId ?? null,
    isGroupOrganizer: input.isGroupOrganizer === true,
    occurredAt: new Date(input.occurredAt).toISOString(),
    sourcePath: input.sourcePath,
    channel: input.channel ?? null,
    staffId: input.staffId ?? null,
    serviceId: input.serviceId ?? null,
    currency: input.currency,
    bookingStatus: input.bookingStatus ?? null,
    bookedSubtotalCents: acceptedPricing?.subtotalCents ?? null,
    bookedTaxCents: acceptedPricing?.taxCents ?? null,
    bookedTotalCents: acceptedPricing?.totalCents ?? null,
    evidence: {
      pricingSnapshot: acceptedPricing !== null,
      pricingFingerprint: acceptedPricing?.pricingFingerprint ?? null,
      pricingSnapshotVersion: acceptedPricing?.snapshotVersion ?? null,
      coverageReasons: [...new Set(reasons)].sort(),
      groupAggregateParity:
        aggregate && input.sourcePath === "canonical_group_member" && input.isGroupOrganizer
          ? aggregate
          : null,
    },
  };
}

function stableRowMaterial(row: FinancialReportRow): string {
  return canonicalFinancialJson(row);
}

function dedupeRows(rows: readonly FinancialReportRow[]): FinancialReportRow[] {
  const byRowId = new Map<string, FinancialReportRow>();
  const bookingToRow = new Map<string, FinancialReportRow>();
  for (const row of rows) {
    const previousId = byRowId.get(row.rowId);
    if (previousId) {
      if (stableRowMaterial(previousId) !== stableRowMaterial(row)) {
        throw new Error("financial_report_conflicting_duplicate_row");
      }
      continue;
    }
    if (row.bookingId) {
      const previousBooking = bookingToRow.get(row.bookingId);
      if (previousBooking) {
        if (stableRowMaterial(previousBooking) !== stableRowMaterial(row)) {
          throw new Error("financial_report_conflicting_duplicate_booking");
        }
        continue;
      }
      bookingToRow.set(row.bookingId, row);
    }
    byRowId.set(row.rowId, row);
  }
  return canonicalizeFinancialReportRows([...byRowId.values()]);
}

function assertGroupParity(rows: readonly FinancialReportRow[]): void {
  const byGroup = new Map<string, FinancialReportRow[]>();
  for (const row of rows) {
    if (row.sourcePath !== "canonical_group_member" || !row.groupId) continue;
    const group = byGroup.get(row.groupId) ?? [];
    group.push(row);
    byGroup.set(row.groupId, group);
  }

  for (const members of byGroup.values()) {
    const organizers = members.filter((row) => row.evidence.groupAggregateParity);
    if (organizers.length > 1) throw new Error("financial_report_multiple_group_aggregates");
    const aggregate = organizers[0]?.evidence.groupAggregateParity;
    if (!aggregate) continue;

    const bookingIds = members.map((row) => row.bookingId).filter((id): id is string => id !== null).sort();
    if (members.some((row) => row.bookedTotalCents === null)) {
      throw new Error("financial_report_group_aggregate_mismatch");
    }
    const subtotal = members.reduce((sum, row) => sum + (row.bookedSubtotalCents ?? 0), 0);
    const tax = members.reduce((sum, row) => sum + (row.bookedTaxCents ?? 0), 0);
    const total = members.reduce((sum, row) => sum + (row.bookedTotalCents ?? 0), 0);
    if (
      bookingIds.length !== members.length ||
      JSON.stringify(bookingIds) !== JSON.stringify(aggregate.memberBookingIds) ||
      subtotal !== aggregate.subtotalCents ||
      tax !== aggregate.taxCents ||
      total !== aggregate.totalCents
    ) {
      throw new Error("financial_report_group_aggregate_mismatch");
    }
  }
}

function sumKnown(rows: readonly FinancialReportRow[], key: "bookedSubtotalCents" | "bookedTaxCents" | "bookedTotalCents"): number | null {
  const values = rows.map((row) => row[key]).filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new Error("financial_report_amount_overflow");
  return total;
}

function coverage(
  rows: readonly FinancialReportRow[],
  metric: FinancialCoverageMetric,
  operationEvents: readonly FinancialOperationEvidence[],
): FinancialCoverage {
  const sourceCounts: Record<string, number> = {};
  for (const row of rows) sourceCounts[row.sourcePath] = (sourceCounts[row.sourcePath] ?? 0) + 1;

  if (metric === "tips" || metric === "commission") {
    return {
      unit: "evidence",
      state: "not_configured",
      includedRows: 0,
      excludedRows: rows.length,
      reasonCodes: [`${metric}_evidence_not_configured`],
      sourceCounts,
    };
  }

  if (metric === "payments" || metric === "refunds") {
    const relevant = operationEvents.filter((operation) =>
      metric === "payments"
        ? CHARGE_KINDS.has(operation.kind)
        : REFUND_KINDS.has(operation.kind));
    const included = relevant.filter((operation) =>
      operation.status === "succeeded" &&
      (metric === "payments"
        ? operation.evidencedGrossCents !== null
        : operation.evidencedRefundCents !== null),
    );
    const excluded = relevant.length - included.length;
    return {
      unit: "operation",
      state: included.length > 0 ? "partial" : "unknown",
      includedRows: included.length,
      excludedRows: excluded,
      reasonCodes: [...new Set([
        ...(included.length === 0
          ? [metric === "payments"
            ? "provider_collected_evidence_missing"
            : "provider_refund_evidence_missing"]
          : []),
        ...(excluded > 0 ? ["provider_operation_unsettled"] : []),
        metric === "payments"
          ? "service_and_external_payments_not_reconciled"
          : "external_refunds_not_reconciled",
      ])],
      sourceCounts: Object.fromEntries(
        [...new Set(relevant.map((operation) => operation.kind))]
          .sort()
          .map((kind) => [kind, relevant.filter((operation) => operation.kind === kind).length]),
      ),
    };
  }

  const included = rows.filter((row) =>
    metric === "tax"
        ? row.bookedTaxCents !== null
        : row.bookedTotalCents !== null,
  );
  const excluded = rows.filter((row) => !included.includes(row));
  const state: FinancialCoverage["state"] =
    included.length === rows.length && rows.length > 0
      ? "complete"
      : included.length > 0
        ? "partial"
        : "unknown";
  const reasonCodes = [...new Set(excluded.flatMap((row) =>
    row.evidence.coverageReasons.filter((reason) =>
      !reason.startsWith("provider_"),
    ),
  ))].sort();
  return {
    unit: "booking",
    ...(metric === "tax" ? { basis: "booking_estimate" as const } : {}),
    state,
    includedRows: included.length,
    excludedRows: excluded.length,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    sourceCounts,
  };
}

export function buildFinancialReport(input: BuildFinancialReportInput): BuiltFinancialReport {
  if (!validCurrency(input.salon.currency)) throw new Error("financial_report_invalid_salon_currency");
  if (!validIso(input.generatedAt) || !validIso(input.dataAsOf)) {
    throw new Error("financial_report_invalid_as_of");
  }

  const rows = dedupeRows(input.rows.map(classifyFinancialEvidence));
  const operations = [...(input.operationEvents ?? [])];
  if (operations.some((operation) => !validOperation(operation, input.salon.currency))) {
    throw new Error("financial_report_operation_evidence_invalid");
  }
  const operationIds = new Set<string>();
  const receiptIds = new Set<string>();
  const currentRangeCharges = new Map<string, FinancialOperationEvidence>();
  const refundReferenceMaterial = new Map<string, string>();
  const inRangeRefundedAmounts = new Map<string, number>();
  for (const operation of operations) {
    if (operationIds.has(operation.operationId)) throw new Error("financial_report_duplicate_operation");
    operationIds.add(operation.operationId);
    const financialReceiptIds = CHARGE_KINDS.has(operation.kind)
      ? [operation.providerPaymentId]
      : [operation.providerRefundId];
    for (const receiptId of financialReceiptIds) {
      if (!receiptId) continue;
      const receiptKey = `${operation.provider}:${operation.providerAccountFingerprint}:${receiptId}`;
      if (receiptIds.has(receiptKey)) throw new Error("financial_report_duplicate_provider_receipt");
      receiptIds.add(receiptKey);
    }
    if (CHARGE_KINDS.has(operation.kind)) {
      if (operation.parentOperationId !== null) throw new Error("financial_report_operation_parent_invalid");
      if (operation.status === "succeeded") currentRangeCharges.set(operation.operationId, operation);
    }
  }
  for (const operation of operations) {
    if (!REFUND_KINDS.has(operation.kind)) continue;
    const reference = operation.parentReference;
    if (!reference) throw new Error("financial_report_operation_parent_invalid");
    const referenceMaterial = canonicalFinancialJson(reference);
    const priorReference = refundReferenceMaterial.get(reference.operationId);
    if (priorReference && priorReference !== referenceMaterial) {
      throw new Error("financial_report_operation_parent_conflict");
    }
    refundReferenceMaterial.set(reference.operationId, referenceMaterial);
    const currentParent = currentRangeCharges.get(reference.operationId);
    if (currentParent && (
      currentParent.bookingId !== reference.bookingId ||
      currentParent.provider !== reference.provider ||
      currentParent.providerAccountFingerprint !== reference.providerAccountFingerprint ||
      currentParent.providerPaymentId !== reference.providerPaymentId ||
      currentParent.currency !== reference.currency ||
      currentParent.requestedAmountCents !== reference.requestedAmountCents
    )) throw new Error("financial_report_operation_parent_invalid");
    if (
      operation.status === "succeeded" &&
      reference.cumulativeSucceededRefundCents < operation.requestedAmountCents
    ) {
      throw new Error("financial_report_refund_exceeds_charge");
    }
    if (operation.status === "succeeded") {
      const inRangeRefunded =
        (inRangeRefundedAmounts.get(reference.operationId) ?? 0) + operation.requestedAmountCents;
      if (inRangeRefunded > reference.cumulativeSucceededRefundCents) {
        throw new Error("financial_report_refund_exceeds_cumulative");
      }
      inRangeRefundedAmounts.set(reference.operationId, inRangeRefunded);
    }
  }
  operations.sort((a, b) =>
    a.occurredAt.localeCompare(b.occurredAt) || a.operationId.localeCompare(b.operationId));
  const rangeStart = Date.parse(input.range.utcFrom);
  const rangeEnd = Date.parse(input.range.utcToExclusive);
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeStart >= rangeEnd) {
    throw new Error("financial_report_invalid_range");
  }
  if (rows.some((row) => {
    const occurredAt = Date.parse(row.occurredAt);
    return occurredAt < rangeStart || occurredAt >= rangeEnd;
  })) throw new Error("financial_report_booking_out_of_range");
  if (operations.some((operation) => {
    const occurredAt = Date.parse(operation.occurredAt);
    return occurredAt < rangeStart || occurredAt >= rangeEnd;
  })) throw new Error("financial_report_operation_out_of_range");
  const partitions = partitionFinancialRowsByCurrency(rows);
  if (partitions.length > 1) throw new Error("financial_report_mixed_currency");
  if (partitions[0] && partitions[0].currency !== input.salon.currency) {
    throw new Error("financial_report_currency_mismatch");
  }
  assertGroupParity(rows);

  const hasBooking = rows.some((row) => row.bookedTotalCents !== null);
  const hasProvider = operations.some((operation) =>
    operation.evidencedGrossCents !== null || operation.evidencedRefundCents !== null);
  const basis = hasBooking && hasProvider
    ? "mixed_with_separate_totals"
    : hasProvider
      ? "provider_collected"
      : "booking_estimate";

  const report: FinancialReportDTO = {
    schemaVersion: FINANCIAL_REPORT_SCHEMA_VERSION,
    reportFingerprint: null,
    sourceFingerprint: null,
    salon: input.salon,
    range: input.range,
    generatedAt: new Date(input.generatedAt).toISOString(),
    dataAsOf: new Date(input.dataAsOf).toISOString(),
    basis,
    coverage: {
      bookingPricing: coverage(rows, "bookingPricing", operations),
      tax: coverage(rows, "tax", operations),
      payments: coverage(rows, "payments", operations),
      tips: coverage(rows, "tips", operations),
      refunds: coverage(rows, "refunds", operations),
      commission: coverage(rows, "commission", operations),
    },
    totals: {
      bookedSubtotalCents: sumKnown(rows, "bookedSubtotalCents"),
      bookedTaxCents: sumKnown(rows, "bookedTaxCents"),
      bookedTotalCents: sumKnown(rows, "bookedTotalCents"),
      collectedGrossCents: sumOperations(operations, "evidencedGrossCents"),
      tipCents: null,
      refundCents: sumOperations(operations, "evidencedRefundCents"),
      collectedNetCents: sumOperations(operations, "evidencedNetCents"),
      commissionCents: null,
    },
    bookingRows: rows,
    operationEvents: operations,
    metricEvents: [],
    metricPolicies: [],
  };
  return { report, fingerprintMaterial: financialReportFingerprintMaterial(report) };
}
