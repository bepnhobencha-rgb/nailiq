/**
 * Type-only + constant companion for superadminActions.ts. Lives in a
 * separate module because Next.js requires "use server" files to export
 * ONLY async functions — types and constants need their own home.
 */

export const SUPPORTED_PLAN_OVERRIDES = [
  "free",
  "pro",
  "premium",
] as const;
export type SuperAdminPlanOverride =
  (typeof SUPPORTED_PLAN_OVERRIDES)[number]
  | null;

/**
 * Recognised feature-flag keys. The DB column is freeform jsonb so
 * adding new keys doesn't require a migration; this list scopes the
 * SuperAdmin UI and is the source of truth for what gets rendered as
 * a row.
 */
export const SUPERADMIN_FEATURE_FLAG_KEYS = [
  "loyalty",
  "reports",
  "audit_log",
  "beta_features",
  "unlimited_staff",
  "unlimited_services",
] as const;
export type SuperAdminFeatureFlagKey =
  (typeof SUPERADMIN_FEATURE_FLAG_KEYS)[number];

export type SuperAdminFeatureFlags = Partial<
  Record<SuperAdminFeatureFlagKey, boolean>
>;

export type SuperAdminSalonRow = {
  id: string;
  slug: string;
  name: string;
  /** Owner phone (E.164 digits or empty). UI masks before render. */
  phone: string;
  subscription_plan: string | null;
  plan_override: SuperAdminPlanOverride;
  feature_flags: SuperAdminFeatureFlags;
  is_beta: boolean;
  admin_notes: string | null;
  created_at: string | null;
  /** Bookings whose `start_time_utc` falls in the current calendar
   * month (UTC). Excludes status='cancelled' since those represent
   * voided traffic, not real demand. */
  bookings_this_month: number;
};

export type LoadAllSalonsResult =
  | { ok: true; salons: SuperAdminSalonRow[] }
  | {
      ok: false;
      error: "unauthorized" | "server_error";
    };

export type UpdateSalonFlagsInput = {
  planOverride?: SuperAdminPlanOverride;
  featureFlags?: SuperAdminFeatureFlags;
  isBeta?: boolean;
  adminNotes?: string | null;
};

export type UpdateSalonFlagsResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "invalid_payload"
        | "not_found"
        | "server_error";
    };

export function normalizeFeatureFlags(input: unknown): SuperAdminFeatureFlags {
  if (!input || typeof input !== "object") return {};
  const src = input as Record<string, unknown>;
  const out: SuperAdminFeatureFlags = {};
  for (const key of SUPERADMIN_FEATURE_FLAG_KEYS) {
    if (typeof src[key] === "boolean") {
      out[key] = src[key] as boolean;
    }
  }
  return out;
}

export function normalizePlanOverride(input: unknown): SuperAdminPlanOverride {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  return (SUPPORTED_PLAN_OVERRIDES as readonly string[]).includes(trimmed)
    ? (trimmed as SuperAdminPlanOverride)
    : null;
}
