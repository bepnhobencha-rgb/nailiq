/**
 * Subscription plan limits.
 *
 * Source of truth for what each plan unlocks. Mirrored from Stripe via
 * the webhook (`/api/stripe/webhook`); UI gates and server-side limit
 * checks read from here so plan/feature decisions stay co-located.
 *
 * `Infinity` represents "unlimited" — JavaScript's numeric infinity is
 * comparable with `<` / `<=` and round-trips through JSON as `null`,
 * which we never persist (limits live in code, not DB).
 */

export type SubscriptionPlan = "free" | "pro" | "premium";

export const SUBSCRIPTION_PLANS: readonly SubscriptionPlan[] = [
  "free",
  "pro",
  "premium",
] as const;

export type PlanLimits = {
  /** Max active staff rows; `Infinity` for unlimited. */
  maxStaff: number;
  /** Max service catalog rows; `Infinity` for unlimited. */
  maxServices: number;
  /** Owner reports panel (`/dashboard/[slug]/reports`). */
  hasReports: boolean;
  /** Owner audit log section in Settings. */
  hasAuditLog: boolean;
};

export const PLAN_LIMITS: Record<SubscriptionPlan, PlanLimits> = {
  free: {
    maxStaff: 3,
    maxServices: 10,
    hasReports: false,
    hasAuditLog: false,
  },
  pro: {
    maxStaff: 10,
    maxServices: 50,
    hasReports: true,
    hasAuditLog: true,
  },
  premium: {
    maxStaff: Number.POSITIVE_INFINITY,
    maxServices: Number.POSITIVE_INFINITY,
    hasReports: true,
    hasAuditLog: true,
  },
};

export function isSubscriptionPlan(value: unknown): value is SubscriptionPlan {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_PLANS as readonly string[]).includes(value)
  );
}

export function parseSubscriptionPlan(value: unknown): SubscriptionPlan {
  return isSubscriptionPlan(value) ? value : "free";
}

export function getPlanLimits(plan: string | null | undefined): PlanLimits {
  return PLAN_LIMITS[parseSubscriptionPlan(plan)];
}

/**
 * Limit-gate helpers. The salon row carries `subscription_plan`; we
 * accept it as a loose shape so callers can pass either the resolved
 * row or a `{ subscription_plan }` projection.
 */
export type PlanCheckSalon = {
  subscription_plan?: string | null;
};

export function canAddStaff(
  salon: PlanCheckSalon,
  currentStaffCount: number,
): boolean {
  return currentStaffCount < getPlanLimits(salon.subscription_plan).maxStaff;
}

export function canAddService(
  salon: PlanCheckSalon,
  currentServiceCount: number,
): boolean {
  return (
    currentServiceCount < getPlanLimits(salon.subscription_plan).maxServices
  );
}
