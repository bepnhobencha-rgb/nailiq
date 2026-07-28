export type AiTenantControlState = {
  archived_at?: string | null;
  superadmin_locked_at?: string | null;
  subscription_status?: string | null;
};

const OPERATIONAL_SUBSCRIPTION_STATES = new Set([
  "active",
  "trialing",
  "past_due",
]);

/**
 * Fail closed when the tenant control-plane state is incomplete or unknown.
 * Past-due salons remain operational during billing recovery; canceled,
 * archived, and superadmin-locked salons must not receive autonomous work.
 */
export function canRunAutonomousAiForTenant(
  salon: AiTenantControlState,
): boolean {
  return (
    salon.archived_at === null &&
    salon.superadmin_locked_at === null &&
    typeof salon.subscription_status === "string" &&
    OPERATIONAL_SUBSCRIPTION_STATES.has(salon.subscription_status)
  );
}
