import {
  canonicalFinancialJson,
  type FinancialReportDTO,
} from "./financialReportDto";

const HEADERS = [
  "record_type", "report_fingerprint", "key", "id", "booking_id",
  "group_id", "parent_operation_id", "occurred_at", "source_or_kind",
  "status", "provider", "currency", "amount_1_cents", "amount_2_cents",
  "amount_3_cents", "value", "coverage_state", "included_rows",
  "excluded_rows", "reason_codes", "canonical_json",
] as const;

type Cell = string | number | null;
type ExportRow = Partial<Record<(typeof HEADERS)[number], Cell>>;

function protectSpreadsheetFormula(value: string): string {
  const firstMaterial = value.match(/[^\u0000-\u0020\u007f]/)?.[0];
  return firstMaterial && "=+-@".includes(firstMaterial) ? `'${value}` : value;
}

function csvCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "number" ? String(value) : protectSpreadsheetFormula(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function serializeRow(value: ExportRow): string {
  return HEADERS.map((header) => csvCell(value[header] ?? null)).join(",");
}

/** RFC 4180 rendering of the exact immutable, PII-minimized report DTO. */
export function renderFinancialReportCsv(report: FinancialReportDTO): string {
  if (!report.reportFingerprint || !/^[0-9a-f]{64}$/.test(report.reportFingerprint)) {
    throw new Error("financial_report_fingerprint_missing");
  }
  const fp = report.reportFingerprint;
  const rows: ExportRow[] = [
    Object.fromEntries(HEADERS.map((header) => [header, header])) as ExportRow,
    { record_type: "metadata", report_fingerprint: fp, key: "report", value: report.schemaVersion },
    { record_type: "metadata", report_fingerprint: fp, key: "source_fingerprint", value: report.sourceFingerprint },
    { record_type: "metadata", report_fingerprint: fp, key: "salon_id", value: report.salon.id },
    { record_type: "metadata", report_fingerprint: fp, key: "salon_name", value: report.salon.name },
    { record_type: "metadata", report_fingerprint: fp, key: "timezone", value: report.salon.timezone },
    { record_type: "metadata", report_fingerprint: fp, key: "currency", value: report.salon.currency },
    { record_type: "metadata", report_fingerprint: fp, key: "local_from", value: report.range.localFrom },
    { record_type: "metadata", report_fingerprint: fp, key: "local_to_exclusive", value: report.range.localToExclusive },
    { record_type: "metadata", report_fingerprint: fp, key: "utc_from", value: report.range.utcFrom },
    { record_type: "metadata", report_fingerprint: fp, key: "utc_to_exclusive", value: report.range.utcToExclusive },
    { record_type: "metadata", report_fingerprint: fp, key: "effective_utc_to_exclusive", value: report.range.effectiveUtcToExclusive },
    { record_type: "metadata", report_fingerprint: fp, key: "generated_at", value: report.generatedAt },
    { record_type: "metadata", report_fingerprint: fp, key: "data_as_of", value: report.dataAsOf },
    { record_type: "metadata", report_fingerprint: fp, key: "basis", value: report.basis },
    { record_type: "metadata", report_fingerprint: fp, key: "booking_row_count", value: report.bookingRows.length },
    { record_type: "metadata", report_fingerprint: fp, key: "operation_event_count", value: report.operationEvents.length },
    { record_type: "metadata", report_fingerprint: fp, key: "metric_event_count", value: report.metricEvents.length },
    { record_type: "metadata", report_fingerprint: fp, key: "metric_policy_count", value: report.metricPolicies.length },
  ];

  for (const metric of Object.keys(report.coverage).sort() as Array<keyof typeof report.coverage>) {
    const value = report.coverage[metric];
    rows.push({
      record_type: "coverage", report_fingerprint: fp, key: metric,
      source_or_kind: value.unit, status: value.basis ?? null,
      coverage_state: value.state, included_rows: value.includedRows,
      excluded_rows: value.excludedRows, reason_codes: value.reasonCodes.join("|"),
      canonical_json: canonicalFinancialJson(value),
    });
  }
  for (const [key, value] of Object.entries(report.totals).sort(([a], [b]) => a.localeCompare(b))) {
    rows.push({ record_type: "total", report_fingerprint: fp, key, currency: report.salon.currency, amount_1_cents: value });
  }
  for (const booking of report.bookingRows) {
    rows.push({
      record_type: "booking", report_fingerprint: fp, id: booking.rowId,
      booking_id: booking.bookingId, group_id: booking.groupId,
      occurred_at: booking.occurredAt, source_or_kind: booking.sourcePath,
      status: booking.bookingStatus, currency: booking.currency,
      amount_1_cents: booking.bookedSubtotalCents,
      amount_2_cents: booking.bookedTaxCents,
      amount_3_cents: booking.bookedTotalCents,
      value: booking.channel, reason_codes: booking.evidence.coverageReasons.join("|"),
      canonical_json: canonicalFinancialJson(booking),
    });
  }
  for (const event of report.operationEvents) {
    rows.push({
      record_type: "operation", report_fingerprint: fp, key: event.requestId,
      id: event.operationId, booking_id: event.bookingId,
      parent_operation_id: event.parentOperationId, occurred_at: event.occurredAt,
      source_or_kind: event.kind, status: event.status, provider: event.provider,
      currency: event.currency, amount_1_cents: event.evidencedGrossCents,
      amount_2_cents: event.evidencedRefundCents,
      amount_3_cents: event.evidencedNetCents,
      value: event.providerRefundId ?? event.providerPaymentId,
      canonical_json: canonicalFinancialJson(event),
    });
  }
  for (const event of report.metricEvents) {
    rows.push({
      record_type: "metric_event", report_fingerprint: fp, id: event.evidenceId,
      booking_id: event.bookingId, occurred_at: event.occurredAt,
      source_or_kind: event.metric, status: event.effect, provider: event.provider,
      currency: event.currency, amount_1_cents: event.amountCents,
      amount_3_cents: event.signedAmountCents, value: event.providerReceiptId,
      canonical_json: canonicalFinancialJson(event),
    });
  }
  for (const policy of report.metricPolicies) {
    rows.push({
      record_type: "metric_policy", report_fingerprint: fp, id: policy.policyId,
      occurred_at: policy.approvedAt, source_or_kind: policy.metric,
      value: policy.policyVersion, canonical_json: canonicalFinancialJson(policy),
    });
  }
  return `${rows.map(serializeRow).join("\r\n")}\r\n`;
}
