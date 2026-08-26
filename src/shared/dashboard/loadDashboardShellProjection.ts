import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type DashboardShellProjection = {
  setupWizardCompletedAt: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
  trialEndsAt: string | null;
  waitingCount: number;
  waitlistCount: number;
  overdueCount: number;
  pendingApprovalsCount: number;
};

type ProjectionResult = DashboardShellProjection | null;

const dashboardShellFlights = new Map<string, Promise<ProjectionResult>>();

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  return value;
}

function count(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseProjection(value: unknown): ProjectionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const setupWizardCompletedAt = nullableString(row.setup_wizard_completed_at);
  const stripeSubscriptionId = nullableString(row.stripe_subscription_id);
  const subscriptionStatus = nullableString(row.subscription_status);
  const trialEndsAt = nullableString(row.trial_ends_at);
  const waitingCount = count(row.waiting_count);
  const waitlistCount = count(row.waitlist_count);
  const overdueCount = count(row.overdue_count);
  const pendingApprovalsCount = count(row.pending_approvals_count);
  if (
    setupWizardCompletedAt === undefined ||
    stripeSubscriptionId === undefined ||
    subscriptionStatus === undefined ||
    trialEndsAt === undefined ||
    waitingCount === null ||
    waitlistCount === null ||
    overdueCount === null ||
    pendingApprovalsCount === null
  ) {
    return null;
  }
  return {
    setupWizardCompletedAt,
    stripeSubscriptionId,
    subscriptionStatus,
    trialEndsAt,
    waitingCount,
    waitlistCount,
    overdueCount,
    pendingApprovalsCount,
  };
}

async function queryDashboardShellProjection(
  salonId: string,
  todayStartUtc: string,
): Promise<ProjectionResult> {
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "load_dashboard_shell_projection" as never,
      {
        p_salon_id: salonId,
        p_today_start: todayStartUtc,
        p_now: new Date().toISOString(),
      } as never,
    );
    if (error) return null;
    return parseProjection(data);
  } catch {
    return null;
  }
}

/**
 * Share only the active read for one authorized salon/day. The promise is
 * removed immediately after settlement, so the next document observes fresh
 * queue, approval and billing state without a post-revocation cache window.
 */
export async function loadDashboardShellProjection(
  salonId: string,
  todayStartUtc: string,
): Promise<ProjectionResult> {
  const key = `${salonId}\0${todayStartUtc}`;
  const existing = dashboardShellFlights.get(key);
  if (existing) return existing;
  if (dashboardShellFlights.size >= 512) {
    return queryDashboardShellProjection(salonId, todayStartUtc);
  }

  const flight = queryDashboardShellProjection(salonId, todayStartUtc);
  dashboardShellFlights.set(key, flight);
  try {
    return await flight;
  } finally {
    if (dashboardShellFlights.get(key) === flight) {
      dashboardShellFlights.delete(key);
    }
  }
}
