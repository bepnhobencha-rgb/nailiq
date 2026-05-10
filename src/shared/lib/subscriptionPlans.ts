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
 *
 * SuperAdmin overrides (added 2026-05-10):
 * - `plan_override` short-circuits subscription_plan when non-null.
 * - `feature_flags.unlimited_staff` lifts maxStaff to Infinity.
 * - `feature_flags.unlimited_services` lifts maxServices to Infinity.
 *
 * Existing callers pass `{ subscription_plan }` only; the new fields
 * are optional and absent → no change in behaviour.
 */
export type PlanCheckSalon = {
  subscription_plan?: string | null;
  plan_override?: string | null;
  feature_flags?: Record<string, unknown> | null;
};

/**
 * The plan that actually applies to a salon, after SuperAdmin
 * `plan_override` resolution. Falls back to subscription_plan, then
 * "free" if both are null/invalid.
 */
export function getEffectivePlan(salon: PlanCheckSalon): SubscriptionPlan {
  const override = salon.plan_override;
  if (typeof override === "string" && isSubscriptionPlan(override)) {
    return override;
  }
  return parseSubscriptionPlan(salon.subscription_plan);
}

function readBooleanFlag(
  flags: PlanCheckSalon["feature_flags"],
  key: string,
): boolean {
  if (!flags || typeof flags !== "object") return false;
  const value = (flags as Record<string, unknown>)[key];
  return value === true;
}

/**
 * Plan limits applied to this salon, after `plan_override` resolution
 * AND `feature_flags` overrides (`unlimited_staff` /
 * `unlimited_services` lift their respective caps to Infinity).
 */
export function getEffectivePlanLimits(salon: PlanCheckSalon): PlanLimits {
  const base = PLAN_LIMITS[getEffectivePlan(salon)];
  const flags = salon.feature_flags ?? null;

  if (
    !readBooleanFlag(flags, "unlimited_staff") &&
    !readBooleanFlag(flags, "unlimited_services")
  ) {
    return base;
  }

  return {
    ...base,
    maxStaff: readBooleanFlag(flags, "unlimited_staff")
      ? Number.POSITIVE_INFINITY
      : base.maxStaff,
    maxServices: readBooleanFlag(flags, "unlimited_services")
      ? Number.POSITIVE_INFINITY
      : base.maxServices,
  };
}

export function canAddStaff(
  salon: PlanCheckSalon,
  currentStaffCount: number,
): boolean {
  return currentStaffCount < getEffectivePlanLimits(salon).maxStaff;
}

export function canAddService(
  salon: PlanCheckSalon,
  currentServiceCount: number,
): boolean {
  return currentServiceCount < getEffectivePlanLimits(salon).maxServices;
}
