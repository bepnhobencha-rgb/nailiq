import { resolveTenantEntitlements } from "@/shared/subscriptions/tenantEntitlements";

export type AiTenantControlState = {
  archived_at?: string | null;
  superadmin_locked_at?: string | null;
  subscription_status?: string | null;
  trial_ends_at?: string | null;
  feature_flags?: unknown;
};

/**
 * Fail closed when the tenant control-plane state is incomplete or unknown.
 * Past-due salons remain operational during billing recovery; canceled,
 * archived, and superadmin-locked salons must not receive autonomous work.
 */
export function canRunAutonomousAiForTenant(
  salon: AiTenantControlState,
  now: Date = new Date(),
): boolean {
  // These control-plane columns are mandatory for AI execution. A malformed
  // projection must never be interpreted as an ordinary legacy tenant.
  if (
    salon.archived_at !== null ||
    salon.superadmin_locked_at !== null ||
    typeof salon.subscription_status !== "string"
  ) {
    return false;
  }
  return resolveTenantEntitlements(salon, now).canRunAutonomousAi;
}
