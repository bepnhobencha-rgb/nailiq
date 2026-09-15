export const TRIAL_EXPIRY_POLICY_FLAG =
  "trial_expiry_policy_version" as const;
export const TRIAL_EXPIRY_POLICY_VERSION = 1 as const;
export const TRIAL_CONTINUITY_DAYS = 7 as const;

export type TenantEntitlementState =
  | "legacy"
  | "active_trial"
  | "trial_continuity"
  | "trial_read_only"
  | "active"
  | "past_due"
  | "canceled"
  | "archived"
  | "locked"
  | "unknown";

export type TenantEntitlementInput = {
  archived_at?: string | null;
  superadmin_locked_at?: string | null;
  subscription_status?: string | null;
  trial_ends_at?: string | null;
  feature_flags?: unknown;
};

export type TenantEntitlements = {
  state: TenantEntitlementState;
  policyEnforced: boolean;
  trialEndsAt: string | null;
  continuityEndsAt: string | null;
  canViewOperationalData: boolean;
  canExportData: boolean;
  canManageSubscription: boolean;
  canCreateNewBooking: boolean;
  canServiceExistingBooking: boolean;
  canSendTransactionalReminder: boolean;
  canRunAutonomousAi: boolean;
  canRunMarketing: boolean;
  canStartVoiceSession: boolean;
  canDispatchNewCharge: boolean;
};

function featureFlags(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function withTrialExpiryPolicy(
  existing: unknown,
): Record<string, unknown> {
  return {
    ...featureFlags(existing),
    [TRIAL_EXPIRY_POLICY_FLAG]: TRIAL_EXPIRY_POLICY_VERSION,
  };
}

function capabilities(
  state: TenantEntitlementState,
  policyEnforced: boolean,
  trialEndsAt: string | null,
  continuityEndsAt: string | null,
): TenantEntitlements {
  const fullyOperational =
    state === "legacy" ||
    state === "active_trial" ||
    state === "active" ||
    state === "past_due";
  const continuity = state === "trial_continuity";
  const dataAccessible = fullyOperational || continuity ||
    state === "trial_read_only" || state === "canceled";

  return {
    state,
    policyEnforced,
    trialEndsAt,
    continuityEndsAt,
    canViewOperationalData: dataAccessible,
    canExportData: dataAccessible,
    canManageSubscription: dataAccessible,
    canCreateNewBooking: fullyOperational,
    canServiceExistingBooking: fullyOperational || continuity,
    canSendTransactionalReminder: fullyOperational || continuity,
    canRunAutonomousAi: fullyOperational,
    canRunMarketing: fullyOperational,
    canStartVoiceSession: fullyOperational,
    canDispatchNewCharge: fullyOperational,
  };
}

/**
 * One pure entitlement decision for dashboard, booking, outbound and worker
 * boundaries. Existing salons are deliberately left on their current behavior
 * until the versioned marker is applied; new registrations receive the marker.
 */
export function resolveTenantEntitlements(
  input: TenantEntitlementInput,
  now: Date = new Date(),
): TenantEntitlements {
  if (input.archived_at) {
    return capabilities("archived", false, null, null);
  }
  if (input.superadmin_locked_at) {
    return capabilities("locked", false, null, null);
  }

  const status = input.subscription_status?.trim().toLowerCase() ?? "";
  const policyEnforced =
    featureFlags(input.feature_flags)[TRIAL_EXPIRY_POLICY_FLAG] ===
    TRIAL_EXPIRY_POLICY_VERSION;

  if (!policyEnforced) {
    if (["active", "trialing", "past_due"].includes(status)) {
      return capabilities("legacy", false, null, null);
    }
    if (status === "canceled") {
      return capabilities("canceled", false, null, null);
    }
    return capabilities("unknown", false, null, null);
  }

  if (status === "active") {
    return capabilities("active", true, null, null);
  }
  if (status === "past_due") {
    return capabilities("past_due", true, null, null);
  }
  if (status === "canceled") {
    return capabilities("canceled", true, null, null);
  }
  if (status !== "trialing") {
    return capabilities("unknown", true, null, null);
  }

  const endMs = Date.parse(input.trial_ends_at ?? "");
  if (!Number.isFinite(endMs)) {
    return capabilities("trial_read_only", true, null, null);
  }
  const trialEndsAt = new Date(endMs).toISOString();
  const continuityEndMs =
    endMs + TRIAL_CONTINUITY_DAYS * 24 * 60 * 60 * 1000;
  const continuityEndsAt = new Date(continuityEndMs).toISOString();
  const nowMs = now.getTime();

  if (Number.isFinite(nowMs) && nowMs < endMs) {
    return capabilities(
      "active_trial",
      true,
      trialEndsAt,
      continuityEndsAt,
    );
  }
  if (Number.isFinite(nowMs) && nowMs < continuityEndMs) {
    return capabilities(
      "trial_continuity",
      true,
      trialEndsAt,
      continuityEndsAt,
    );
  }
  return capabilities(
    "trial_read_only",
    true,
    trialEndsAt,
    continuityEndsAt,
  );
}
