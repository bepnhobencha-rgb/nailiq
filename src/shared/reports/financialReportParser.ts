import {
  canonicalizeFinancialOperations,
  canonicalizeFinancialReportRows,
  type FinancialCoverage,
  type FinancialMetricEvent,
  type FinancialMetricPolicy,
  type FinancialOperationEvidence,
  type FinancialReportDTO,
  type FinancialReportRow,
} from "./financialReportDto";
import { isSupportedCurrency } from "@/shared/lib/currencyFormat";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const CURRENCY = /^[A-Z]{3}$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("financial_report_invalid_object");
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 255): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("financial_report_invalid_string");
  return value;
}
function nullableString(value: unknown, max = 255): string | null {
  return value === null ? null : string(value, max);
}
function uuid(value: unknown): string { const parsed = string(value, 36); if (!UUID.test(parsed)) throw new Error("financial_report_invalid_uuid"); return parsed.toLowerCase(); }
function nullableUuid(value: unknown): string | null { return value === null ? null : uuid(value); }
function hash(value: unknown): string { const parsed = string(value, 64); if (!HASH.test(parsed)) throw new Error("financial_report_invalid_hash"); return parsed; }
function nullableHash(value: unknown): string | null { return value === null ? null : hash(value); }
function iso(value: unknown): string { const parsed = string(value, 64); const time = Date.parse(parsed); if (!Number.isFinite(time)) throw new Error("financial_report_invalid_time"); return new Date(time).toISOString(); }
function nullableIso(value: unknown): string | null { return value === null ? null : iso(value); }
function integer(value: unknown): number { if (!Number.isSafeInteger(value)) throw new Error("financial_report_invalid_integer"); return value as number; }
function cents(value: unknown): number { const parsed = integer(value); if (parsed < 0) throw new Error("financial_report_invalid_cents"); return parsed; }
function nullableCents(value: unknown): number | null { return value === null ? null : cents(value); }
function boolean(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("financial_report_invalid_boolean"); return value; }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error("financial_report_invalid_array"); return value; }

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error("financial_report_invalid_enum");
  return value as T;
}

function parseCoverage(value: unknown): FinancialCoverage {
  const row = object(value);
  const reasons = array(row.reasonCodes).map((item) => string(item, 80));
  const sourceCountsRaw = object(row.sourceCounts);
  const sourceCounts = Object.fromEntries(Object.entries(sourceCountsRaw).map(([key, count]) => {
    if (!/^[a-z0-9_:.-]{1,80}$/.test(key)) throw new Error("financial_report_invalid_source_count");
    const parsed = cents(count);
    return [key, parsed];
  }).sort(([a], [b]) => String(a).localeCompare(String(b))));
  return {
    unit: enumValue(row.unit, ["booking", "operation", "evidence"] as const),
    ...(row.basis === undefined ? {} : { basis: enumValue(row.basis, ["booking_estimate"] as const) }),
    state: enumValue(row.state, ["complete", "partial", "unknown", "not_configured"] as const),
    includedRows: cents(row.includedRows),
    excludedRows: cents(row.excludedRows),
    reasonCodes: [...new Set(reasons)].sort(),
    sourceCounts,
  };
}

function parseBooking(value: unknown): FinancialReportRow {
  const row = object(value);
  const evidence = object(row.evidence);
  const aggregateRaw = evidence.groupAggregateParity;
  const aggregate = aggregateRaw === null ? null : (() => {
    const item = object(aggregateRaw);
    const memberBookingIds = array(item.memberBookingIds).map(uuid).sort();
    return {
      memberBookingIds,
      subtotalCents: cents(item.subtotalCents),
      taxCents: cents(item.taxCents),
      totalCents: cents(item.totalCents),
    };
  })();
  const currency = string(row.currency, 3);
  if (!CURRENCY.test(currency)) throw new Error("financial_report_invalid_currency");
  return {
    rowId: uuid(row.rowId), bookingId: nullableUuid(row.bookingId),
    groupId: nullableUuid(row.groupId), isGroupOrganizer: boolean(row.isGroupOrganizer),
    occurredAt: iso(row.occurredAt),
    sourcePath: enumValue(row.sourcePath, ["canonical_individual", "canonical_group_member", "canonical_desk", "canonical_voice", "legacy", "wix_schedule", "square_schedule", "controlled_after_hours", "archived_recovery"] as const),
    channel: nullableString(row.channel, 64), staffId: nullableUuid(row.staffId),
    serviceId: nullableUuid(row.serviceId), currency,
    bookingStatus: nullableString(row.bookingStatus, 40),
    bookedSubtotalCents: nullableCents(row.bookedSubtotalCents),
    bookedTaxCents: nullableCents(row.bookedTaxCents),
    bookedTotalCents: nullableCents(row.bookedTotalCents),
    evidence: {
      pricingSnapshot: boolean(evidence.pricingSnapshot),
      pricingFingerprint: nullableHash(evidence.pricingFingerprint),
      pricingSnapshotVersion: evidence.pricingSnapshotVersion === null ? null : cents(evidence.pricingSnapshotVersion),
      coverageReasons: [...new Set(array(evidence.coverageReasons).map((item) => string(item, 80)))].sort(),
      groupAggregateParity: aggregate,
    },
  };
}

function parseOperation(value: unknown): FinancialOperationEvidence {
  const row = object(value);
  const parentRaw = row.parentReference;
  const parentReference = parentRaw === null ? null : (() => {
    const parent = object(parentRaw);
    const providerAccountFingerprint = hash(parent.providerAccountFingerprint);
    const currency = string(parent.currency, 3);
    if (!CURRENCY.test(currency)) throw new Error("financial_report_invalid_currency");
    return {
      operationId: uuid(parent.operationId), bookingId: nullableUuid(parent.bookingId),
      provider: enumValue(parent.provider, ["square", "stripe"] as const),
      providerAccountFingerprint, providerPaymentId: string(parent.providerPaymentId),
      currency, requestedAmountCents: cents(parent.requestedAmountCents),
      cumulativeSucceededRefundCents: cents(parent.cumulativeSucceededRefundCents),
    };
  })();
  const currency = string(row.currency, 3);
  if (!CURRENCY.test(currency)) throw new Error("financial_report_invalid_currency");
  return {
    operationId: uuid(row.operationId), requestId: uuid(row.requestId),
    parentOperationId: nullableUuid(row.parentOperationId), bookingId: nullableUuid(row.bookingId),
    occurredAt: iso(row.occurredAt),
    kind: enumValue(row.kind, ["deposit_charge", "noshow_charge", "late_cancel_charge", "deposit_refund", "noshow_refund", "late_cancel_refund"] as const),
    provider: enumValue(row.provider, ["square", "stripe"] as const),
    providerAccountFingerprint: hash(row.providerAccountFingerprint),
    status: enumValue(row.status, ["succeeded", "pending", "unknown", "failed"] as const),
    providerPaymentId: nullableString(row.providerPaymentId),
    providerRefundId: nullableString(row.providerRefundId), currency,
    requestedAmountCents: cents(row.requestedAmountCents),
    materialFingerprint: hash(row.materialFingerprint),
    evidencedGrossCents: nullableCents(row.evidencedGrossCents),
    evidencedRefundCents: nullableCents(row.evidencedRefundCents),
    evidencedNetCents: row.evidencedNetCents === null ? null : integer(row.evidencedNetCents),
    parentReference,
  };
}

function parseMetricEvent(value: unknown): FinancialMetricEvent {
  const row = object(value); const currency = string(row.currency, 3);
  if (!CURRENCY.test(currency)) throw new Error("financial_report_invalid_currency");
  return {
    evidenceId: uuid(row.evidenceId), metric: enumValue(row.metric, ["tips", "commission"] as const),
    bookingId: uuid(row.bookingId), paymentOperationId: nullableUuid(row.paymentOperationId),
    policyId: uuid(row.policyId), staffId: nullableUuid(row.staffId), serviceId: nullableUuid(row.serviceId),
    occurredAt: iso(row.occurredAt),
    sourceKind: enumValue(row.sourceKind, ["provider_receipt", "manual_verified", "policy_calculation"] as const),
    sourceEventId: string(row.sourceEventId), currency,
    effect: enumValue(row.effect, ["credit", "debit"] as const), amountCents: cents(row.amountCents),
    signedAmountCents: integer(row.signedAmountCents),
    provider: row.provider === null ? null : enumValue(row.provider, ["square", "stripe"] as const),
    providerAccountFingerprint: nullableHash(row.providerAccountFingerprint),
    providerReceiptId: nullableString(row.providerReceiptId), materialFingerprint: hash(row.materialFingerprint),
  };
}

function parseMetricPolicy(value: unknown): FinancialMetricPolicy {
  const row = object(value);
  return {
    policyId: uuid(row.policyId), metric: enumValue(row.metric, ["tips", "commission"] as const),
    policyVersion: string(row.policyVersion, 64), effectiveFrom: iso(row.effectiveFrom),
    effectiveTo: nullableIso(row.effectiveTo), definitionFingerprint: hash(row.definitionFingerprint),
    approvedAt: iso(row.approvedAt),
  };
}

function sumNullable(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  if (known.length === 0) return null;
  const total = known.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new Error("financial_report_amount_overflow");
  return total;
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}
function sameCounts(actual: Record<string, number>, expected: Record<string, number>): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function parseFinancialReportDto(value: unknown): FinancialReportDTO {
  const row = object(value); const salon = object(row.salon); const range = object(row.range);
  const currency = string(salon.currency, 3); if (!CURRENCY.test(currency) || !isSupportedCurrency(currency)) throw new Error("financial_report_invalid_currency");
  const coverageRaw = object(row.coverage); const totalsRaw = object(row.totals);
  const bookingRows = canonicalizeFinancialReportRows(array(row.bookingRows).map(parseBooking));
  const operationEvents = canonicalizeFinancialOperations(array(row.operationEvents).map(parseOperation));
  const metricEvents = array(row.metricEvents).map(parseMetricEvent).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.evidenceId.localeCompare(b.evidenceId));
  const metricPolicies = array(row.metricPolicies).map(parseMetricPolicy).sort((a, b) => a.metric.localeCompare(b.metric) || a.effectiveFrom.localeCompare(b.effectiveFrom) || a.policyId.localeCompare(b.policyId));
  const parsed: FinancialReportDTO = {
    schemaVersion: integer(row.schemaVersion) as 2,
    reportFingerprint: nullableHash(row.reportFingerprint), sourceFingerprint: nullableHash(row.sourceFingerprint),
    salon: { id: uuid(salon.id), name: string(salon.name, 200), timezone: string(salon.timezone, 100), currency },
    range: {
      localFrom: string(range.localFrom, 10), localToExclusive: string(range.localToExclusive, 10),
      utcFrom: iso(range.utcFrom), utcToExclusive: iso(range.utcToExclusive),
      effectiveUtcToExclusive: iso(range.effectiveUtcToExclusive),
    },
    generatedAt: iso(row.generatedAt), dataAsOf: iso(row.dataAsOf),
    basis: enumValue(row.basis, ["booking_estimate", "provider_collected", "mixed_with_separate_totals"] as const),
    coverage: {
      bookingPricing: parseCoverage(coverageRaw.bookingPricing), tax: parseCoverage(coverageRaw.tax),
      payments: parseCoverage(coverageRaw.payments), tips: parseCoverage(coverageRaw.tips),
      refunds: parseCoverage(coverageRaw.refunds), commission: parseCoverage(coverageRaw.commission),
    },
    totals: {
      bookedSubtotalCents: nullableCents(totalsRaw.bookedSubtotalCents), bookedTaxCents: nullableCents(totalsRaw.bookedTaxCents),
      bookedTotalCents: nullableCents(totalsRaw.bookedTotalCents), collectedGrossCents: nullableCents(totalsRaw.collectedGrossCents),
      tipCents: nullableCents(totalsRaw.tipCents), refundCents: nullableCents(totalsRaw.refundCents),
      collectedNetCents: totalsRaw.collectedNetCents === null ? null : integer(totalsRaw.collectedNetCents),
      commissionCents: nullableCents(totalsRaw.commissionCents),
    },
    bookingRows, operationEvents, metricEvents, metricPolicies,
  };
  if (parsed.schemaVersion !== 2) throw new Error("financial_report_schema_unsupported");
  const start = Date.parse(parsed.range.utcFrom);
  const bookingEnd = Date.parse(parsed.range.utcToExclusive);
  const evidenceEnd = Date.parse(parsed.range.effectiveUtcToExclusive);
  if (start >= bookingEnd || evidenceEnd < start || evidenceEnd > bookingEnd || evidenceEnd > Date.parse(parsed.dataAsOf)) throw new Error("financial_report_invalid_range");
  if (bookingRows.some((item) => Date.parse(item.occurredAt) < start || Date.parse(item.occurredAt) >= bookingEnd)) throw new Error("financial_report_booking_out_of_range");
  if (operationEvents.some((item) => Date.parse(item.occurredAt) < start || Date.parse(item.occurredAt) >= evidenceEnd)) throw new Error("financial_report_operation_out_of_range");
  if (metricEvents.some((item) => Date.parse(item.occurredAt) < start || Date.parse(item.occurredAt) >= evidenceEnd)) throw new Error("financial_report_metric_out_of_range");

  for (const booking of bookingRows) {
    if (booking.currency !== parsed.salon.currency) throw new Error("financial_report_booking_currency_mismatch");
    if (booking.evidence.pricingSnapshot) {
      if (
        booking.bookingStatus !== "completed" ||
        booking.bookedSubtotalCents === null ||
        booking.bookedTaxCents === null ||
        booking.bookedTotalCents === null ||
        booking.evidence.pricingFingerprint === null ||
        booking.evidence.pricingSnapshotVersion === null ||
        booking.bookedSubtotalCents + booking.bookedTaxCents !== booking.bookedTotalCents
      ) throw new Error("financial_report_booking_evidence_invalid");
    } else if (
      booking.bookedSubtotalCents !== null ||
      booking.bookedTaxCents !== null ||
      booking.bookedTotalCents !== null ||
      booking.evidence.pricingFingerprint !== null ||
      booking.evidence.pricingSnapshotVersion !== null ||
      booking.evidence.coverageReasons.length === 0
    ) {
      throw new Error("financial_report_booking_evidence_invalid");
    }
  }
  const seenBookingRows = new Set<string>();
  const groupRows = new Map<string, FinancialReportRow[]>();
  for (const booking of bookingRows) {
    if (seenBookingRows.has(booking.rowId)) throw new Error("financial_report_duplicate_booking_row");
    seenBookingRows.add(booking.rowId);
    if (booking.bookingId !== booking.rowId) throw new Error("financial_report_booking_identity_invalid");
    if (booking.groupId === null) {
      if (booking.isGroupOrganizer || booking.evidence.groupAggregateParity !== null) throw new Error("financial_report_group_evidence_invalid");
      continue;
    }
    const rows = groupRows.get(booking.groupId) ?? []; rows.push(booking); groupRows.set(booking.groupId, rows);
    const aggregate = booking.evidence.groupAggregateParity;
    if (!booking.isGroupOrganizer && aggregate !== null) throw new Error("financial_report_group_evidence_invalid");
    if (aggregate) {
      if (!booking.isGroupOrganizer || !booking.evidence.pricingSnapshot || new Set(aggregate.memberBookingIds).size !== aggregate.memberBookingIds.length || !aggregate.memberBookingIds.includes(booking.bookingId!) || aggregate.subtotalCents + aggregate.taxCents !== aggregate.totalCents) throw new Error("financial_report_group_evidence_invalid");
    }
  }
  for (const rows of groupRows.values()) {
    const organizers = rows.filter((item) => item.isGroupOrganizer);
    // The DB validates the whole group, while a half-open report can contain
    // only members whose organizer occurs outside this range.
    if (organizers.length > 1) throw new Error("financial_report_group_evidence_invalid");
    const included = rows.some((item) => item.evidence.pricingSnapshot);
    const aggregate = organizers[0]?.evidence.groupAggregateParity ?? null;
    if (included && organizers.length === 1 && !aggregate) throw new Error("financial_report_group_evidence_invalid");
    if (aggregate && rows.some((item) => item.bookingId && !aggregate.memberBookingIds.includes(item.bookingId))) throw new Error("financial_report_group_evidence_invalid");
  }

  const operationIds = new Set<string>();
  const receipts = new Set<string>();
  const refundReferences = new Map<string, string>();
  const refundsInRange = new Map<string, number>();
  for (const event of operationEvents) {
    if (event.currency !== parsed.salon.currency) throw new Error("financial_report_operation_currency_mismatch");
    if (operationIds.has(event.operationId)) throw new Error("financial_report_duplicate_operation");
    operationIds.add(event.operationId);
    const isCharge = event.kind.endsWith("_charge");
    const isFinal = event.status === "succeeded";
    if (isFinal) {
      if (isCharge) {
        if (!event.providerPaymentId || event.providerRefundId !== null || event.parentReference !== null || event.parentOperationId !== null || event.evidencedGrossCents !== event.requestedAmountCents || event.evidencedRefundCents !== null || event.evidencedNetCents !== event.requestedAmountCents) throw new Error("financial_report_operation_evidence_invalid");
      } else if (!event.providerPaymentId || !event.providerRefundId || !event.parentReference || event.parentOperationId !== event.parentReference.operationId || event.evidencedGrossCents !== null || event.evidencedRefundCents !== event.requestedAmountCents || event.evidencedNetCents !== -event.requestedAmountCents) {
        throw new Error("financial_report_operation_evidence_invalid");
      }
    } else if (event.evidencedGrossCents !== null || event.evidencedRefundCents !== null || event.evidencedNetCents !== null) {
      throw new Error("financial_report_operation_evidence_invalid");
    }
    const receipt = isCharge ? event.providerPaymentId : event.providerRefundId;
    if (receipt) {
      const receiptKey = `${event.provider}:${event.providerAccountFingerprint}:${receipt}`;
      if (receipts.has(receiptKey)) throw new Error("financial_report_duplicate_provider_receipt");
      receipts.add(receiptKey);
    }
    if (!isCharge && event.parentReference) {
      const parent = event.parentReference;
      if (parent.bookingId !== event.bookingId || parent.provider !== event.provider || parent.providerAccountFingerprint !== event.providerAccountFingerprint || parent.providerPaymentId !== event.providerPaymentId || parent.currency !== event.currency || parent.cumulativeSucceededRefundCents > parent.requestedAmountCents) throw new Error("financial_report_operation_parent_invalid");
      const parentMaterial = JSON.stringify(parent);
      const prior = refundReferences.get(parent.operationId);
      if (prior && prior !== parentMaterial) throw new Error("financial_report_operation_parent_conflict");
      refundReferences.set(parent.operationId, parentMaterial);
      if (isFinal) {
        const cumulative = (refundsInRange.get(parent.operationId) ?? 0) + event.requestedAmountCents;
        if (cumulative > parent.cumulativeSucceededRefundCents) throw new Error("financial_report_refund_exceeds_cumulative");
        refundsInRange.set(parent.operationId, cumulative);
      }
    }
  }

  const policies = new Map(metricPolicies.map((policy) => [policy.policyId, policy]));
  if (policies.size !== metricPolicies.length) throw new Error("financial_report_duplicate_metric_policy");
  for (const metric of ["tips", "commission"] as const) {
    const scoped = metricPolicies
      .filter((policy) => policy.metric === metric)
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    for (let index = 0; index < scoped.length; index += 1) {
      const policy = scoped[index]!;
      if (
        (metric === "tips" && policy.policyVersion !== "tips-staff-100-proportional-v1") ||
        (metric === "commission" && policy.policyVersion !== "commission-estimate-net-service-v1") ||
        (policy.effectiveTo !== null && Date.parse(policy.effectiveTo) <= Date.parse(policy.effectiveFrom))
      ) throw new Error("financial_report_metric_policy_invalid");
      const next = scoped[index + 1];
      if (next && (policy.effectiveTo === null || Date.parse(policy.effectiveTo) > Date.parse(next.effectiveFrom))) {
        throw new Error("financial_report_metric_policy_overlap");
      }
    }
  }
  for (const event of metricEvents) {
    if (event.signedAmountCents !== (event.effect === "credit" ? event.amountCents : -event.amountCents)) throw new Error("financial_report_metric_amount_invalid");
    const policy = policies.get(event.policyId);
    if (!policy || policy.metric !== event.metric || Date.parse(event.occurredAt) < Date.parse(policy.effectiveFrom) || (policy.effectiveTo !== null && Date.parse(event.occurredAt) >= Date.parse(policy.effectiveTo))) throw new Error("financial_report_metric_policy_invalid");
    if (event.currency !== parsed.salon.currency) throw new Error("financial_report_metric_currency_mismatch");
    if (event.sourceKind === "provider_receipt" ? (!event.provider || !event.providerAccountFingerprint || !event.providerReceiptId || !event.paymentOperationId) : Boolean(event.provider || event.providerAccountFingerprint || event.providerReceiptId)) throw new Error("financial_report_metric_provider_invalid");
  }
  const bookingSubtotal = sumNullable(bookingRows.map((item) => item.bookedSubtotalCents));
  const bookingTax = sumNullable(bookingRows.map((item) => item.bookedTaxCents));
  const bookingTotal = sumNullable(bookingRows.map((item) => item.bookedTotalCents));
  const gross = sumNullable(operationEvents.map((item) => item.evidencedGrossCents));
  const refunds = sumNullable(operationEvents.map((item) => item.evidencedRefundCents));
  const net = sumNullable(operationEvents.map((item) => item.evidencedNetCents));
  if (bookingSubtotal !== parsed.totals.bookedSubtotalCents || bookingTax !== parsed.totals.bookedTaxCents || bookingTotal !== parsed.totals.bookedTotalCents || gross !== parsed.totals.collectedGrossCents || refunds !== parsed.totals.refundCents || net !== parsed.totals.collectedNetCents) throw new Error("financial_report_totals_mismatch");
  const tipTotal = sumNullable(metricEvents.filter((item) => item.metric === "tips").map((item) => item.signedAmountCents));
  const commissionTotal = sumNullable(metricEvents.filter((item) => item.metric === "commission").map((item) => item.signedAmountCents));
  if (tipTotal !== parsed.totals.tipCents || commissionTotal !== parsed.totals.commissionCents) throw new Error("financial_report_metric_totals_mismatch");
  if (parsed.coverage.tips.state === "not_configured" && (parsed.totals.tipCents !== null || metricEvents.some((item) => item.metric === "tips") || metricPolicies.some((item) => item.metric === "tips"))) throw new Error("financial_report_tip_policy_mismatch");
  if (parsed.coverage.commission.state === "not_configured" && (parsed.totals.commissionCents !== null || metricEvents.some((item) => item.metric === "commission") || metricPolicies.some((item) => item.metric === "commission"))) throw new Error("financial_report_commission_policy_mismatch");
  const bookingIncluded = bookingRows.filter((item) => item.evidence.pricingSnapshot).length;
  const chargeEvents = operationEvents.filter((item) => item.kind.endsWith("_charge"));
  const refundEvents = operationEvents.filter((item) => item.kind.endsWith("_refund"));
  const chargeIncluded = chargeEvents.filter((item) => item.evidencedGrossCents !== null).length;
  const refundIncluded = refundEvents.filter((item) => item.evidencedRefundCents !== null).length;
  const exactCounts = (
    coverage: FinancialCoverage,
    included: number,
    total: number,
  ) => coverage.includedRows === included && coverage.excludedRows === total - included;
  if (!exactCounts(parsed.coverage.bookingPricing, bookingIncluded, bookingRows.length) || !exactCounts(parsed.coverage.tax, bookingIncluded, bookingRows.length) || !exactCounts(parsed.coverage.payments, chargeIncluded, chargeEvents.length) || !exactCounts(parsed.coverage.refunds, refundIncluded, refundEvents.length)) throw new Error("financial_report_coverage_count_mismatch");
  const bookingState = bookingIncluded === 0 ? "unknown" : bookingIncluded === bookingRows.length ? "complete" : "partial";
  const paymentState = chargeIncluded === 0 ? "unknown" : "partial";
  const refundState = refundIncluded === 0 ? "unknown" : "partial";
  if (
    parsed.coverage.bookingPricing.state !== bookingState || parsed.coverage.tax.state !== bookingState ||
    parsed.coverage.payments.state !== paymentState || parsed.coverage.refunds.state !== refundState ||
    parsed.coverage.bookingPricing.unit !== "booking" || parsed.coverage.tax.unit !== "booking" || parsed.coverage.tax.basis !== "booking_estimate" ||
    parsed.coverage.payments.unit !== "operation" || parsed.coverage.refunds.unit !== "operation" ||
    !sameCounts(parsed.coverage.bookingPricing.sourceCounts, countBy(bookingRows.map((item) => item.sourcePath))) ||
    !sameCounts(parsed.coverage.tax.sourceCounts, countBy(bookingRows.map((item) => item.sourcePath))) ||
    !sameCounts(parsed.coverage.payments.sourceCounts, countBy(chargeEvents.map((item) => item.kind))) ||
    !sameCounts(parsed.coverage.refunds.sourceCounts, countBy(refundEvents.map((item) => item.kind)))
  ) throw new Error("financial_report_coverage_state_mismatch");
  if (
    (parsed.coverage.bookingPricing.excludedRows === 0 && parsed.coverage.bookingPricing.reasonCodes.length !== 0) ||
    (parsed.coverage.bookingPricing.excludedRows > 0 && parsed.coverage.bookingPricing.reasonCodes.length === 0) ||
    JSON.stringify(parsed.coverage.bookingPricing.reasonCodes) !== JSON.stringify(parsed.coverage.tax.reasonCodes)
  ) throw new Error("financial_report_coverage_reason_mismatch");
  if (
    !parsed.coverage.payments.reasonCodes.includes("service_and_external_payments_not_reconciled") ||
    !parsed.coverage.refunds.reasonCodes.includes("external_refunds_not_reconciled")
  ) throw new Error("financial_report_coverage_scope_uncertified");
  const validateMetric = (
    metric: "tips" | "commission",
    coverage: FinancialCoverage,
    total: number | null,
  ) => {
    const events = metricEvents.filter((event) => event.metric === metric);
    const configured = metricPolicies.some((policy) => policy.metric === metric);
    const unconfiguredReason = metric === "tips"
      ? "authoritative_tip_ingestion_not_configured"
      : "approved_commission_policy_not_configured";
    const missingReason = metric === "tips" ? "tip_evidence_missing" : "commission_evidence_missing";
    const partialReason = metric === "tips"
      ? "tip_sources_not_fully_reconciled"
      : "commission_estimate_not_payroll";
    const expectedSources = countBy(events.map((event) => event.sourceKind));
    if (
      coverage.unit !== "evidence" || coverage.excludedRows !== 0 ||
      coverage.includedRows !== events.length ||
      !sameCounts(coverage.sourceCounts, expectedSources)
    ) throw new Error("financial_report_metric_configuration_invalid");
    if (!configured) {
      if (
        events.length !== 0 || total !== null || coverage.state !== "not_configured" ||
        coverage.reasonCodes.join("|") !== unconfiguredReason
      ) throw new Error("financial_report_metric_configuration_invalid");
      return;
    }
    if (events.length === 0) {
      if (
        total !== null || coverage.state !== "unknown" ||
        coverage.reasonCodes.join("|") !== missingReason
      ) throw new Error("financial_report_metric_configuration_invalid");
      return;
    }
    if (
      coverage.state !== "partial" ||
      coverage.reasonCodes.join("|") !== partialReason
    ) throw new Error("financial_report_metric_configuration_invalid");
  };
  validateMetric("tips", parsed.coverage.tips, parsed.totals.tipCents);
  validateMetric("commission", parsed.coverage.commission, parsed.totals.commissionCents);
  const expectedBasis = bookingIncluded > 0 && chargeIncluded + refundIncluded > 0
    ? "mixed_with_separate_totals"
    : chargeIncluded + refundIncluded > 0 ? "provider_collected" : "booking_estimate";
  if (parsed.basis !== expectedBasis) throw new Error("financial_report_basis_mismatch");
  return parsed;
}
