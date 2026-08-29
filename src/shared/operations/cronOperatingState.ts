import "server-only";

import type { CronWorkerName } from "@/shared/ai/executionHeartbeat";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

type CronHeartbeatRow = {
  worker_name: CronWorkerName;
  run_id: string | null;
  status: "unknown" | "running" | "succeeded" | "failed";
  started_at: string | null;
  completed_at: string | null;
  succeeded_at: string | null;
  last_error: string | null;
};

export type CronRouteHealth = {
  workerName: CronWorkerName;
  label: string;
  schedule: string;
  status:
    | "healthy"
    | "running"
    | "failed"
    | "stale"
    | "pending"
    | "missing";
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSucceededAt: string | null;
  lastError: string | null;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const CRON_ROUTE_CONTRACTS: ReadonlyArray<{
  workerName: CronWorkerName;
  label: string;
  schedule: string;
  staleAfterMs: number;
}> = [
  { workerName: "ai_execution", label: "AI execution", schedule: "Every 5 minutes", staleAfterMs: 15 * MINUTE },
  { workerName: "ai_manager", label: "AI manager", schedule: "Hourly", staleAfterMs: 2 * HOUR },
  { workerName: "campaign_scheduler", label: "Campaign scheduler", schedule: "Every 15 minutes", staleAfterMs: 45 * MINUTE },
  { workerName: "close_stale_in_progress", label: "Close stale operational states", schedule: "Hourly", staleAfterMs: 3 * HOUR },
  { workerName: "deposit_compensation", label: "Deposit compensation", schedule: "Every minute", staleAfterMs: 5 * MINUTE },
  { workerName: "error_triage", label: "Error triage", schedule: "Every 10 minutes", staleAfterMs: 30 * MINUTE },
  { workerName: "minh_learn", label: "Minh learning", schedule: "Daily", staleAfterMs: 30 * HOUR },
  { workerName: "nail_tryon_cleanup", label: "Nail try-on cleanup", schedule: "Hourly", staleAfterMs: 3 * HOUR },
  { workerName: "noshow_card_nudge", label: "No-show card nudge", schedule: "Twice daily", staleAfterMs: 30 * HOUR },
  { workerName: "noshow_charge_retry", label: "No-show safety finalizer", schedule: "Every minute", staleAfterMs: 10 * MINUTE },
  { workerName: "payment_reconciliation", label: "Payment reconciliation", schedule: "Every minute", staleAfterMs: 5 * MINUTE },
  { workerName: "release_review", label: "Release review email", schedule: "Every 5 minutes", staleAfterMs: 15 * MINUTE },
  { workerName: "reminders", label: "Booking reminders", schedule: "Every 15 minutes", staleAfterMs: 45 * MINUTE },
  { workerName: "send_pending_notifications", label: "Pending notifications", schedule: "Every minute", staleAfterMs: 5 * MINUTE },
  { workerName: "spend_sync", label: "Channel spend sync", schedule: "Daily", staleAfterMs: 30 * HOUR },
  { workerName: "square_email_consent", label: "Square email consent", schedule: "Daily", staleAfterMs: 30 * HOUR },
  { workerName: "square_sync", label: "Square sync", schedule: "Every 5 minutes", staleAfterMs: 15 * MINUTE },
  { workerName: "tenant_payment_pause", label: "Tenant payment pause", schedule: "Hourly", staleAfterMs: 3 * HOUR },
  { workerName: "waitlist_advance", label: "Waitlist advance", schedule: "Every 5 minutes", staleAfterMs: 15 * MINUTE },
  { workerName: "wix_sync", label: "Wix sync", schedule: "Every minute", staleAfterMs: 5 * MINUTE },
];

export function deriveCronRouteHealth(
  contract: (typeof CRON_ROUTE_CONTRACTS)[number],
  heartbeat: CronHeartbeatRow | null,
  now = new Date(),
  monitoringStartedAt: Date | null = null,
): CronRouteHealth {
  const base = {
    workerName: contract.workerName,
    label: contract.label,
    schedule: contract.schedule,
    lastStartedAt: heartbeat?.started_at ?? null,
    lastCompletedAt: heartbeat?.completed_at ?? null,
    lastSucceededAt: heartbeat?.succeeded_at ?? null,
    lastError: heartbeat?.last_error ?? null,
  };
  if (!heartbeat?.started_at || heartbeat.status === "unknown") {
    if (
      monitoringStartedAt &&
      Number.isFinite(monitoringStartedAt.getTime()) &&
      now.getTime() - monitoringStartedAt.getTime() <= contract.staleAfterMs
    ) {
      return { ...base, status: "pending" };
    }
    return { ...base, status: "missing" };
  }
  if (heartbeat.status === "failed") {
    return { ...base, status: "failed" };
  }
  const startedAt = Date.parse(heartbeat.started_at);
  if (
    !Number.isFinite(startedAt) ||
    now.getTime() - startedAt > contract.staleAfterMs
  ) {
    return { ...base, status: "stale" };
  }
  if (heartbeat.status === "running") {
    return { ...base, status: "running" };
  }
  return { ...base, status: "healthy" };
}

export async function loadCronOperatingState(
  now = new Date(),
): Promise<CronRouteHealth[]> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("ai_execution_worker_state" as never)
    .select(
      "worker_name, run_id, status, started_at, completed_at, succeeded_at, last_error",
    );
  if (error) throw new Error("cron_operating_state_unavailable");

  const rows = (data as CronHeartbeatRow[] | null) ?? [];
  const byWorker = new Map(rows.map((row) => [row.worker_name, row]));
  const firstObservedTimestamp = rows.reduce<number | null>((earliest, row) => {
    const timestamp = Date.parse(row.started_at ?? "");
    if (!Number.isFinite(timestamp)) return earliest;
    return earliest === null || timestamp < earliest ? timestamp : earliest;
  }, null);
  const monitoringStartedAt =
    firstObservedTimestamp === null ? null : new Date(firstObservedTimestamp);
  return CRON_ROUTE_CONTRACTS.map((contract) =>
    deriveCronRouteHealth(
      contract,
      byWorker.get(contract.workerName) ?? null,
      now,
      monitoringStartedAt,
    ),
  );
}
