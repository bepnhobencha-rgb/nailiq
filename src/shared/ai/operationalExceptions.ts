import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import type {
  OperationalExceptionRow,
  OperationalExceptionSeverity,
  OperationalExceptionStatus,
} from "@/shared/ai/operationalExceptionTypes";

const VALID_STATUSES = new Set<OperationalExceptionStatus>([
  "open",
  "acknowledged",
  "resolved",
]);
const VALID_SEVERITIES = new Set<OperationalExceptionSeverity>([
  "info",
  "warning",
  "critical",
]);

type OperationalExceptionSourceRow = {
  id: unknown;
  severity: unknown;
  title: unknown;
  body: unknown;
  status: unknown;
  created_at: unknown;
  resolution_note: unknown;
  source_type: unknown;
  occurrence_count: unknown;
  last_seen_at: unknown;
};

const OWNER_EXCEPTION_COLUMNS =
  "id, severity, title, body, status, created_at, resolution_note, source_type, occurrence_count, last_seen_at";

function boundedDisplayText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function toOperationalExceptionDisplayRow(
  row: OperationalExceptionSourceRow,
): OperationalExceptionRow | null {
  const status = String(row.status) as OperationalExceptionStatus;
  const severity = String(row.severity) as OperationalExceptionSeverity;
  if (!VALID_STATUSES.has(status) || !VALID_SEVERITIES.has(severity)) {
    return null;
  }
  const sourceType = String(row.source_type);
  return {
    id: String(row.id),
    severity,
    title: boundedDisplayText(row.title, 160),
    body:
      row.body == null ? null : boundedDisplayText(row.body, 600) || null,
    status,
    created_at: String(row.created_at),
    resolution_note:
      row.resolution_note == null
        ? null
        : boundedDisplayText(row.resolution_note, 500) || null,
    source_type: /^[a-z][a-z0-9_]{0,49}$/.test(sourceType)
      ? sourceType
      : "unknown",
    occurrence_count: Math.max(
      1,
      Math.min(1_000_000, Number(row.occurrence_count) || 1),
    ),
    last_seen_at: String(row.last_seen_at),
  };
}

export async function getOperationalExceptions(
  salonId: string,
  activeLimit = 50,
): Promise<{ items: OperationalExceptionRow[]; activeCount: number }> {
  const db = createServiceRoleClient();
  const [activeResult, resolvedResult, countResult] = await Promise.all([
    db
      .from("watchdog_alerts" as never)
      .select(OWNER_EXCEPTION_COLUMNS as never)
      .eq("salon_id" as never, salonId)
      .in("status" as never, ["open", "acknowledged"] as never)
      .order("created_at" as never, { ascending: false })
      .limit(Math.max(1, Math.min(activeLimit, 50))),
    db
      .from("watchdog_alerts" as never)
      .select(OWNER_EXCEPTION_COLUMNS as never)
      .eq("salon_id" as never, salonId)
      .eq("status" as never, "resolved")
      .order("resolved_at" as never, { ascending: false })
      .limit(2),
    db
      .from("watchdog_alerts" as never)
      .select("id" as never, { count: "exact", head: true })
      .eq("salon_id" as never, salonId)
      .in("status" as never, ["open", "acknowledged"] as never),
  ]);

  if (activeResult.error || resolvedResult.error || countResult.error) {
    throw new Error(
      "operational_exceptions_read_failed",
      {
        cause:
          activeResult.error ?? resolvedResult.error ?? countResult.error,
      },
    );
  }

  const data = [...(activeResult.data ?? []), ...(resolvedResult.data ?? [])];
  const items = (data as unknown as OperationalExceptionSourceRow[])
    .map(toOperationalExceptionDisplayRow)
    .filter((row): row is OperationalExceptionRow => row !== null)
    .sort((a, b) => {
      const statusRank = { open: 0, acknowledged: 1, resolved: 2 };
      const severityRank = { critical: 0, warning: 1, info: 2 };
      return (
        statusRank[a.status] - statusRank[b.status] ||
        severityRank[a.severity] - severityRank[b.severity] ||
        Date.parse(b.created_at) - Date.parse(a.created_at)
      );
    });
  return { items, activeCount: countResult.count ?? items.filter((item) => item.status !== "resolved").length };
}
