import "server-only";

import { createHash } from "node:crypto";

import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  financialReportFingerprintMaterial,
  type FinancialReportDTO,
} from "./financialReportDto";
import { signFinancialReportSnapshot } from "./financialReportExportToken";
import { assertFinancialReportExportable } from "./financialReportExportLimits";
import { parseFinancialReportDto } from "./financialReportParser";
import { checkFinancialReportRateLimits } from "./financialReportRateLimit";

export type LoadFinancialReportResult =
  | { ok: true; report: FinancialReportDTO; exportToken: string }
  | { ok: false; error: "unauthorized" | "forbidden" | "feature_not_enabled" | "invalid_range" | "rate_limited" | "limiter_unavailable" | "report_too_large" | "report_unavailable" };

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function mapCoverage(value: unknown) {
  const row = obj(value);
  return {
    unit: row.unit, basis: row.basis, state: row.state,
    includedRows: row.included_rows, excludedRows: row.excluded_rows,
    reasonCodes: row.reason_codes, sourceCounts: row.source_counts,
  };
}
function mapBooking(value: unknown) {
  const row = obj(value); const evidence = obj(row.evidence); const aggregate = obj(evidence.group_aggregate_parity);
  return {
    rowId: row.row_id, bookingId: row.booking_id, groupId: row.group_id,
    isGroupOrganizer: row.is_group_organizer, occurredAt: row.occurred_at,
    sourcePath: row.source_path, channel: row.channel, staffId: row.staff_id,
    serviceId: row.service_id, currency: row.currency, bookingStatus: row.booking_status,
    bookedSubtotalCents: row.booked_subtotal_cents, bookedTaxCents: row.booked_tax_cents,
    bookedTotalCents: row.booked_total_cents,
    evidence: {
      pricingSnapshot: evidence.pricing_snapshot, pricingFingerprint: evidence.pricing_fingerprint,
      pricingSnapshotVersion: evidence.pricing_snapshot_version,
      coverageReasons: evidence.coverage_reasons,
      groupAggregateParity: evidence.group_aggregate_parity === null ? null : {
        memberBookingIds: aggregate.member_booking_ids, subtotalCents: aggregate.subtotal_cents,
        taxCents: aggregate.tax_cents, totalCents: aggregate.total_cents,
      },
    },
  };
}
function mapOperation(value: unknown) {
  const row = obj(value); const parent = obj(row.parent_reference);
  return {
    operationId: row.operation_id, requestId: row.request_id,
    bookingId: row.booking_id, parentOperationId: row.parent_operation_id,
    occurredAt: row.occurred_at, kind: row.kind, provider: row.provider,
    providerAccountFingerprint: row.provider_account_fingerprint,
    status: row.status, providerPaymentId: row.provider_payment_id,
    providerRefundId: row.provider_refund_id, currency: row.currency,
    requestedAmountCents: row.requested_amount_cents,
    materialFingerprint: row.material_fingerprint,
    evidencedGrossCents: row.evidenced_gross_cents,
    evidencedRefundCents: row.evidenced_refund_cents,
    evidencedNetCents: row.evidenced_net_cents,
    parentReference: row.parent_reference === null ? null : {
      operationId: parent.operation_id, bookingId: parent.booking_id,
      provider: parent.provider, providerAccountFingerprint: parent.provider_account_fingerprint,
      providerPaymentId: parent.provider_payment_id, currency: parent.currency,
      requestedAmountCents: parent.requested_amount_cents,
      cumulativeSucceededRefundCents: parent.cumulative_succeeded_refund_cents,
    },
  };
}
function mapMetricEvent(value: unknown) {
  const row = obj(value);
  return {
    evidenceId: row.evidence_id, metric: row.metric, bookingId: row.booking_id,
    paymentOperationId: row.payment_operation_id, policyId: row.policy_id,
    staffId: row.staff_id, serviceId: row.service_id, occurredAt: row.occurred_at,
    sourceKind: row.source_kind, sourceEventId: row.source_event_id,
    currency: row.currency, effect: row.effect, amountCents: row.amount_cents,
    signedAmountCents: row.signed_amount_cents, provider: row.provider,
    providerAccountFingerprint: row.provider_account_fingerprint,
    providerReceiptId: row.provider_receipt_id, materialFingerprint: row.material_fingerprint,
  };
}
function mapMetricPolicy(value: unknown) {
  const row = obj(value);
  return {
    policyId: row.policy_id, metric: row.metric, policyVersion: row.policy_version,
    effectiveFrom: row.effective_from, effectiveTo: row.effective_to,
    definitionFingerprint: row.definition_fingerprint, approvedAt: row.approved_at,
  };
}

export function mapAuthoritativeFinancialReport(value: unknown): FinancialReportDTO {
  const row = obj(value); const salon = obj(row.salon); const range = obj(row.range);
  const coverage = obj(row.coverage); const totals = obj(row.totals);
  const mapped = {
    schemaVersion: row.schema_version, reportFingerprint: null,
    sourceFingerprint: row.source_fingerprint ?? row.report_fingerprint,
    salon: { id: salon.id, name: salon.name, timezone: salon.timezone, currency: salon.currency },
    range: {
      localFrom: range.local_from, localToExclusive: range.local_to_exclusive,
      utcFrom: range.utc_from, utcToExclusive: range.utc_to_exclusive,
      effectiveUtcToExclusive: range.effective_utc_to_exclusive,
    },
    generatedAt: row.generated_at, dataAsOf: row.data_as_of, basis: row.basis,
    coverage: {
      bookingPricing: mapCoverage(coverage.booking_pricing), tax: mapCoverage(coverage.tax),
      payments: mapCoverage(coverage.payments), tips: mapCoverage(coverage.tips),
      refunds: mapCoverage(coverage.refunds), commission: mapCoverage(coverage.commission),
    },
    totals: {
      bookedSubtotalCents: totals.booked_subtotal_cents, bookedTaxCents: totals.booked_tax_cents,
      bookedTotalCents: totals.booked_total_cents, collectedGrossCents: totals.collected_gross_cents,
      tipCents: totals.tip_cents, refundCents: totals.refund_cents,
      collectedNetCents: totals.collected_net_cents, commissionCents: totals.commission_cents,
    },
    bookingRows: Array.isArray(row.booking_rows) ? row.booking_rows.map(mapBooking) : row.booking_rows,
    operationEvents: Array.isArray(row.operation_events) ? row.operation_events.map(mapOperation) : row.operation_events,
    metricEvents: Array.isArray(row.metric_events) ? row.metric_events.map(mapMetricEvent) : row.metric_events,
    metricPolicies: Array.isArray(row.metric_policies) ? row.metric_policies.map(mapMetricPolicy) : row.metric_policies,
  };
  const parsed = parseFinancialReportDto(mapped);
  if (!parsed.sourceFingerprint) throw new Error("financial_report_source_fingerprint_missing");
  parsed.reportFingerprint = createHash("sha256")
    .update(financialReportFingerprintMaterial(parsed), "utf8")
    .digest("hex");
  return parseFinancialReportDto(parsed);
}

export async function loadFinancialReport(
  slug: string,
  localFrom: string,
  localToExclusive: string,
): Promise<LoadFinancialReportResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(localToExclusive)) {
    return { ok: false, error: "invalid_range" };
  }
  try {
    const resolved = await resolveSalonForDashboard(slug);
    if (!resolved) return { ok: false, error: "unauthorized" };
    if (!isOwnerOrAdmin(resolved.role) || !resolved.viewerUserId) return { ok: false, error: "forbidden" };
    if (!(await isReleaseFeatureVisible(resolved.salon, "advanced_reports"))) {
      return { ok: false, error: "feature_not_enabled" };
    }
    const limiter = await checkFinancialReportRateLimits(resolved.viewerUserId, resolved.salon.id, "load");
    if (limiter !== "allowed") return { ok: false, error: limiter === "rate_limited" ? "rate_limited" : "limiter_unavailable" };
    const admin = createServiceRoleClient();
    const { data, error } = await admin.rpc("load_authoritative_financial_report", {
      p_salon_id: resolved.salon.id,
      p_actor_user_id: resolved.viewerUserId,
      p_local_from: localFrom,
      p_local_to_exclusive: localToExclusive,
      p_data_as_of: null,
    } as never);
    if (error) return { ok: false, error: "report_unavailable" };
    const raw = obj(data);
    if (raw.success !== true || raw.code !== "loaded") {
      if (raw.code === "invalid_range") return { ok: false, error: "invalid_range" };
      if (raw.code === "report_too_large") {
        return { ok: false, error: "report_too_large" };
      }
      return { ok: false, error: "report_unavailable" };
    }
    const report = mapAuthoritativeFinancialReport(raw);
    if (report.salon.id !== resolved.salon.id) return { ok: false, error: "report_unavailable" };
    assertFinancialReportExportable(report);
    const exportToken = signFinancialReportSnapshot(report, resolved.viewerUserId);
    return { ok: true, report, exportToken };
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.message === "financial_report_too_large" ? "report_too_large" : "report_unavailable" };
  }
}
