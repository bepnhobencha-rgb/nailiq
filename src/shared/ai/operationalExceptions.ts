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

export async function getOperationalExceptions(
  salonId: string,
  activeLimit = 50,
): Promise<{ items: OperationalExceptionRow[]; activeCount: number }> {
  const db = createServiceRoleClient();
  const columns =
    "id, kind, severity, title, body, status, created_at, updated_at, acknowledged_at, resolved_at, resolution_note";
  const [activeResult, resolvedResult, countResult] = await Promise.all([
    db
      .from("watchdog_alerts" as never)
      .select(columns as never)
      .eq("salon_id" as never, salonId)
      .in("status" as never, ["open", "acknowledged"] as never)
      .order("created_at" as never, { ascending: false })
      .limit(Math.max(1, Math.min(activeLimit, 50))),
    db
      .from("watchdog_alerts" as never)
      .select(columns as never)
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
    console.error(
      "[getOperationalExceptions]",
      activeResult.error ?? resolvedResult.error ?? countResult.error,
    );
    return { items: [], activeCount: 0 };
  }

  const data = [...(activeResult.data ?? []), ...(resolvedResult.data ?? [])];
  const items = (data as unknown as Array<Record<string, unknown>>)
    .map((row): OperationalExceptionRow | null => {
      const status = String(row.status) as OperationalExceptionStatus;
      const severity = String(row.severity) as OperationalExceptionSeverity;
      if (!VALID_STATUSES.has(status) || !VALID_SEVERITIES.has(severity)) {
        return null;
      }
      return {
        id: String(row.id),
        kind: String(row.kind),
        severity,
        title: String(row.title),
        body: row.body == null ? null : String(row.body),
        status,
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
        acknowledged_at:
          row.acknowledged_at == null ? null : String(row.acknowledged_at),
        resolved_at: row.resolved_at == null ? null : String(row.resolved_at),
        resolution_note:
          row.resolution_note == null ? null : String(row.resolution_note),
      };
    })
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
