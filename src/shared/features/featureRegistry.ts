/**
 * Release Feature Registry — the single source of truth for which product
 * surfaces are part of the **Base** customer-ready release vs **Beta**
 * (unfinished / opt-in) work.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Scope (PR1 — foundation only)
 * ───────────────────────────────────────────────────────────────────────────
 * This module DEFINES the registry + a resolver. It does NOT gate any UI,
 * route, or server action yet — later PRs consume `isReleaseFeatureEnabled`
 * to hide nav (PR2), 404 routes (PR3), and block server actions / SuperAdmin
 * wiring (PR3–PR4). Adding this module changes no runtime behavior on its own.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Release flags vs billing/subscription
 * ───────────────────────────────────────────────────────────────────────────
 * Release flags answer "is this surface shipped/enabled for this salon?" and
 * are deliberately SEPARATE from billing tiers (`subscription_plan`,
 * `PLAN_FEATURES` in `@/lib/feature-gating`). A feature can be Base-stable yet
 * still sit behind a paid plan; the two concerns must not be conflated.
 *
 * Where a release surface already has a per-salon toggle, this registry MAPS
 * to the existing key instead of introducing a duplicate:
 *   - `feature_flags` JSONB keys from `SUPERADMIN_PER_SALON_FLAGS`
 *     (e.g. group_booking_enabled, loyalty_enabled, reports_enabled).
 *   - the dedicated `salons.voice_ai_enabled` column (Voice AI).
 *   - billing-side `PLAN_FEATURES` keys via `hasFeature` (photos, reviews).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Default resolution (no DB row required)
 * ───────────────────────────────────────────────────────────────────────────
 * A salon that has set nothing resolves purely from `defaultOn`:
 *   Base  → ON     Beta → OFF
 * A SuperAdmin override (writing the mapped `feature_flags` key, or the column)
 * wins over the default. See `isReleaseFeatureEnabled` for precedence.
 */

import { hasFeature } from "@/lib/feature-gating";

/** Stable Base release surfaces — default ON. */
export type BaseFeatureKey =
  | "public_booking"
  | "receptionist_center"
  | "basic_mode"
  | "walkin_queue"
  | "calendar_booking_list"
  | "staff_basic"
  | "service_basic"
  | "customer_basic"
  | "bilingual_en_vi"
  | "basic_settings";

/** Beta / unfinished surfaces — default OFF. */
export type BetaFeatureKey =
  | "group_booking"
  | "ai_voice"
  | "loyalty"
  | "reviews"
  | "photos"
  | "marketing"
  | "combos"
  | "tv_mode"
  | "advanced_reports"
  | "experimental_realtime"
  | "admin_copilot"
  | "ai_control_center"
  | "nail_tryon"
  | "archived_booking_recovery";

export type ReleaseFeatureKey = BaseFeatureKey | BetaFeatureKey;

export type ReleasePhase = "base" | "beta";

/**
 * How a release feature's per-salon override is stored, if any. Determines
 * which existing system the resolver reads BEFORE falling back to `defaultOn`.
 *
 *  - "registry": no existing per-salon store — resolves from `defaultOn` only
 *                (a SuperAdmin store is added for these in a later PR).
 *  - "jsonb":    a boolean key in `salons.feature_flags`
 *                (an existing SUPERADMIN_PER_SALON_FLAGS key — `flagKey`).
 *  - "column":   a dedicated boolean column on `salons` (`column`).
 *  - "plan":     a billing-side `PLAN_FEATURES` key read via `hasFeature`
 *                (`planFeature`). Read-only reuse — billing logic is untouched.
 */
export type FeatureSource =
  | { kind: "registry" }
  | { kind: "jsonb"; flagKey: string }
  | { kind: "column"; column: "voice_ai_enabled" }
  | { kind: "plan"; planFeature: string };

export type ReleaseFeatureDescriptor = {
  key: ReleaseFeatureKey;
  /** Human label (EN); VI labels live with the SuperAdmin descriptors in PR4. */
  label: string;
  /** Grouping for docs / future SuperAdmin UI. */
  group: "booking" | "operations" | "catalog" | "customers" | "analytics" | "platform";
  phase: ReleasePhase;
  /** Base → true, Beta → false. The no-override default. */
  defaultOn: boolean;
  /** Where a per-salon override is read from, if any. */
  source: FeatureSource;
  /** One-line intent — also surfaced in docs/FEATURE_FLAGS.md. */
  description: string;
};

/**
 * THE registry. Every release-gateable surface appears exactly once.
 *
 * Mapping notes (verified against the codebase, PR1):
 *   - receptionist_center → existing flag `receptionist_center_enabled`
 *   - walkin_queue        → existing flag `walkin_queue_enabled`
 *   - group_booking       → existing flag `group_booking_enabled`
 *   - loyalty             → existing flag `loyalty_enabled`
 *   - advanced_reports    → existing flag `reports_enabled`
 *   - ai_voice            → existing column `salons.voice_ai_enabled`
 *   - photos              → existing billing feature `photo_confirmation`
 *   - reviews             → existing billing feature `reviews`
 * All other keys are registry-only for now (resolve from `defaultOn`); a
 * per-salon SuperAdmin store is added for them in PR4.
 */
export const RELEASE_FEATURES: Record<ReleaseFeatureKey, ReleaseFeatureDescriptor> = {
  // ── Base (ON) ──────────────────────────────────────────────────────────
  public_booking: {
    key: "public_booking",
    label: "Public Booking",
    group: "booking",
    phase: "base",
    defaultOn: true,
    source: { kind: "registry" },
    description: "Public salon booking page at /[slug].",
  },
  receptionist_center: {
    key: "receptionist_center",
    label: "Receptionist Center",
    group: "operations",
    phase: "base",
    defaultOn: true,
    source: { kind: "jsonb", flagKey: "receptionist_center_enabled" },
    description: "Front-desk receptionist board at /dashboard/[slug]/center.",
  },
  basic_mode: {
    key: "basic_mode",
    label: "Basic Mode",
    group: "operations",
    phase: "base",
    defaultOn: true,
    source: { kind: "registry" },
    description: "Per-device simplified front-desk layout (localStorage toggle).",
  },
  walkin_queue: {
    key: "walkin_queue",
    label: "Walk-in Queue",
    group: "operations",
    phase: "base",
    defaultOn: true,
    source: { kind: "jsonb", flagKey: "walkin_queue_enabled" },
    description: "Walk-in queue panel on the Front Desk.",
  },
  calendar_booking_list: {
    key: "calendar_booking_list",
    label: "Calendar / Booking list",
    group: "booking",
    phase: "base",
    defaultOn: true,
    source: { kind: "registry" },
    description: "Day/week/month calendar + booking list views.",
  },
  staff_basic: {
    key: "staff_basic",
    label: "Staff (basic)",
    group: "catalog",
    phase: "base",
    defaultOn: true,
    source: { kind: "registry" },
    description: "Staff roster, roles, and capabilities.",
  },
  service_basic: {
    key: "service_basic",
    label: "Service (basic)",
    group: "catalog",
    phase: "base",
    defaultOn: true,
    source: { kind: "registry" },
    description: "Service catalog and pricing.",
  },
  customer_basic: {
    key: "customer_basic",
    label: "Customer (basic)",
    group: "customers",
    phase: "base",
    defaultOn: true,
    source: { kind: "registry" },
    description: "Customer list and basic profiles.",
  },
  bilingual_en_vi: {
    key: "bilingual_en_vi",
    label: "Bilingual EN/VI",
    group: "platform",
    phase: "base",
    defaultOn: true,
    source: { kind: "registry" },
    description: "English/Vietnamese UI toggle.",
  },
  basic_settings: {
    key: "basic_settings",
    label: "Basic Settings",
    group: "platform",
    phase: "base",
    defaultOn: true,
    source: { kind: "registry" },
    description: "Salon settings hub (brand, hours, contact, modules).",
  },

  // ── Beta (OFF) ─────────────────────────────────────────────────────────
  group_booking: {
    key: "group_booking",
    label: "Group / Party Booking",
    group: "booking",
    phase: "beta",
    defaultOn: false,
    source: { kind: "jsonb", flagKey: "group_booking_enabled" },
    description: "Multi-guest group/party booking flow.",
  },
  ai_voice: {
    key: "ai_voice",
    label: "AI Voice / Receptionist",
    group: "operations",
    phase: "beta",
    defaultOn: false,
    source: { kind: "column", column: "voice_ai_enabled" },
    description: "AI voice receptionist (WebRTC voice booking).",
  },
  loyalty: {
    key: "loyalty",
    label: "Loyalty",
    group: "customers",
    phase: "beta",
    defaultOn: false,
    source: { kind: "jsonb", flagKey: "loyalty_enabled" },
    description: "Loyalty program / stamps / rewards.",
  },
  reviews: {
    key: "reviews",
    label: "Reviews",
    group: "customers",
    phase: "beta",
    defaultOn: false,
    source: { kind: "plan", planFeature: "reviews" },
    description: "Auto review-request tracking.",
  },
  photos: {
    key: "photos",
    label: "Photos",
    group: "customers",
    phase: "beta",
    defaultOn: false,
    source: { kind: "plan", planFeature: "photo_confirmation" },
    description: "Photo confirmation gallery.",
  },
  marketing: {
    key: "marketing",
    label: "Marketing",
    group: "customers",
    phase: "beta",
    defaultOn: true,
    source: { kind: "registry" },
    description: "Marketing campaigns (re-opt-in, offers). Owner/admin only.",
  },
  combos: {
    key: "combos",
    label: "Combos / Bundles",
    group: "catalog",
    phase: "beta",
    defaultOn: false,
    source: { kind: "registry" },
    description: "Service combos / bundles.",
  },
  tv_mode: {
    key: "tv_mode",
    label: "TV Mode",
    group: "operations",
    phase: "beta",
    defaultOn: false,
    source: { kind: "registry" },
    description: "Big-screen waiting-room display (not yet implemented).",
  },
  advanced_reports: {
    key: "advanced_reports",
    label: "Advanced reports",
    group: "analytics",
    phase: "beta",
    defaultOn: false,
    source: { kind: "jsonb", flagKey: "reports_enabled" },
    description: "Advanced analytics / revenue reports.",
  },
  experimental_realtime: {
    key: "experimental_realtime",
    label: "Experimental realtime widgets",
    group: "platform",
    phase: "beta",
    defaultOn: false,
    source: { kind: "registry" },
    description: "Experimental realtime dashboard widgets.",
  },
  admin_copilot: {
    key: "admin_copilot",
    label: "Admin Copilot (Coco)",
    group: "operations",
    phase: "beta",
    // On by default for every salon. A SuperAdmin can still switch it OFF for a
    // single salon via salons.feature_flags.admin_copilot_enabled=false.
    defaultOn: true,
    source: { kind: "jsonb", flagKey: "admin_copilot_enabled" },
    description: "In-admin AI assistant (Coco) for salon operations guidance.",
  },
  ai_control_center: {
    key: "ai_control_center",
    label: "AI Control Center",
    group: "operations",
    phase: "beta",
    defaultOn: false,
    source: { kind: "jsonb", flagKey: "ai_control_center_enabled" },
    description: "Unified owner view for AI decisions, activity, and outcomes.",
  },
  nail_tryon: {
    key: "nail_tryon",
    label: "AI Nail Try-On",
    group: "booking",
    phase: "beta",
    defaultOn: false,
    source: { kind: "jsonb", flagKey: "nail_tryon_enabled" },
    description: "Private hand-photo preview with a salon nail design before booking.",
  },
  archived_booking_recovery: {
    key: "archived_booking_recovery",
    label: "Archived Booking Recovery",
    group: "operations",
    phase: "beta",
    defaultOn: false,
    source: {
      kind: "jsonb",
      flagKey: "archived_booking_recovery_enabled",
    },
    description:
      "Create a linked replacement for a cancelled/no-show booking without reopening history.",
  },
};

/** Ordered key list (stable for iteration / docs / tests). */
export const RELEASE_FEATURE_KEYS = Object.keys(
  RELEASE_FEATURES,
) as ReleaseFeatureKey[];

export const BASE_FEATURE_KEYS = RELEASE_FEATURE_KEYS.filter(
  (k) => RELEASE_FEATURES[k].phase === "base",
);

export const BETA_FEATURE_KEYS = RELEASE_FEATURE_KEYS.filter(
  (k) => RELEASE_FEATURES[k].phase === "beta",
);

/**
 * Minimal salon shape the resolver needs. A superset of what
 * `hasFeature` requires, plus the optional Voice AI column. All fields are
 * optional/nullable so partial dashboard contexts resolve gracefully to
 * `defaultOn` rather than throwing.
 */
export type ReleaseFeatureSalon = {
  subscription_plan?: string | null;
  plan_override?: string | null;
  feature_flags?: unknown;
  voice_ai_enabled?: boolean | null;
};

function readJsonbFlag(
  featureFlags: unknown,
  flagKey: string,
): boolean | undefined {
  if (!featureFlags || typeof featureFlags !== "object") return undefined;
  const v = (featureFlags as Record<string, unknown>)[flagKey];
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Is a release feature enabled for this salon?
 *
 * Precedence (first decisive wins):
 *   1. An explicit per-salon override in the feature's mapped store:
 *        - "jsonb":  boolean `feature_flags[flagKey]`
 *        - "column": boolean `salons.voice_ai_enabled`
 *        - "plan":   billing `hasFeature(salon, planFeature)` (read-only reuse)
 *   2. The registry `defaultOn` (Base → ON, Beta → OFF). No DB row required.
 *
 * Note: "plan"-sourced features resolve through `hasFeature`, which itself
 * honours a `feature_flags` override before the plan — so SuperAdmin can still
 * force them on/off without this module duplicating billing logic.
 */
export function isReleaseFeatureEnabled(
  salon: ReleaseFeatureSalon,
  key: ReleaseFeatureKey,
): boolean {
  const desc = RELEASE_FEATURES[key];
  const source = desc.source;

  switch (source.kind) {
    case "jsonb": {
      const override = readJsonbFlag(salon.feature_flags, source.flagKey);
      return override ?? desc.defaultOn;
    }
    case "column": {
      const v = salon.voice_ai_enabled;
      return typeof v === "boolean" ? v : desc.defaultOn;
    }
    case "plan": {
      // Reuse billing-side resolution read-only. hasFeature needs the three
      // gating fields; default to "free"/empty when the context is partial.
      return hasFeature(
        {
          subscription_plan: salon.subscription_plan ?? "free",
          plan_override: salon.plan_override ?? null,
          feature_flags: (salon.feature_flags ?? {}) as never,
        },
        source.planFeature,
      );
    }
    case "registry":
    default:
      return desc.defaultOn;
  }
}

/** Convenience: the default (no-override) state for a key. */
export function releaseFeatureDefault(key: ReleaseFeatureKey): boolean {
  return RELEASE_FEATURES[key].defaultOn;
}

/**
 * Effective visibility for EVERY release feature (base + beta), combining the
 * two control planes:
 *
 *   effective(key) = !platformDisabled(key) && isReleaseFeatureEnabled(salon, key)
 *
 * - `platformDisabled`: platform-wide kill-switch (Superadmin). When a key is
 *   in this set the feature is hidden for ALL salons, overriding per-salon.
 * - `isReleaseFeatureEnabled`: per-salon override / plan / registry default.
 *
 * Safe by default: an empty `platformDisabled` set + no per-salon override
 * resolves base features to ON and beta features to their registry default.
 */
export function resolveFeatureVisibility(
  salon: ReleaseFeatureSalon,
  platformDisabled?: ReadonlySet<ReleaseFeatureKey>,
): Record<ReleaseFeatureKey, boolean> {
  const out = {} as Record<ReleaseFeatureKey, boolean>;
  for (const key of RELEASE_FEATURE_KEYS) {
    out[key] =
      !(platformDisabled?.has(key) ?? false) &&
      isReleaseFeatureEnabled(salon, key);
  }
  return out;
}

/**
 * UI grouping for the read-only SuperAdmin release-features panel.
 *
 * Distinct from the registry `phase` (base/beta) and the `group` taxonomy:
 * features whose state is owned by an external store (`plan` billing or the
 * dedicated `column`) are surfaced together so an operator sees at a glance
 * that they are NOT controlled by the per-salon `feature_flags` jsonb.
 *
 *   - "base"        → Base-phase, registry/jsonb-sourced (default ON)
 *   - "beta"        → Beta-phase, registry/jsonb-sourced (default OFF)
 *   - "plan_column" → resolved from billing plan or the voice_ai column
 */
export type ReleaseFeatureUiGroup = "base" | "beta" | "plan_column";

export function releaseFeatureUiGroup(
  key: ReleaseFeatureKey,
): ReleaseFeatureUiGroup {
  const desc = RELEASE_FEATURES[key];
  if (desc.source.kind === "plan" || desc.source.kind === "column") {
    return "plan_column";
  }
  return desc.phase === "base" ? "base" : "beta";
}

/**
 * Read-only resolution snapshot for one feature on one salon — everything the
 * SuperAdmin panel needs to render a row without re-deriving anything.
 *
 * Pure: no I/O, no mutation. `overridden` is true when the salon's resolved
 * state differs from the registry default (a per-salon flag, the voice column,
 * a plan/plan_override, or a `feature_flags` billing override pushed it off the
 * default). It is purely descriptive — this never writes anything.
 */
export type ReleaseFeatureResolution = {
  key: ReleaseFeatureKey;
  label: string;
  description: string;
  group: ReleaseFeatureDescriptor["group"];
  phase: ReleasePhase;
  uiGroup: ReleaseFeatureUiGroup;
  /** Resolved ON/OFF for this salon (`isReleaseFeatureEnabled`). */
  resolved: boolean;
  /** Registry no-override default (Base → ON, Beta → OFF). */
  defaultOn: boolean;
  /** Where the resolver read the state from. */
  source: FeatureSource["kind"];
  /** True when `resolved` diverges from `defaultOn` for this salon. */
  overridden: boolean;
};

/**
 * Describe how a single release feature resolves for a given salon. Pure,
 * read-only — wraps `isReleaseFeatureEnabled` and the registry descriptor into
 * the shape the SuperAdmin read-only panel consumes.
 */
export function describeReleaseFeatureForSalon(
  salon: ReleaseFeatureSalon,
  key: ReleaseFeatureKey,
): ReleaseFeatureResolution {
  const desc = RELEASE_FEATURES[key];
  const resolved = isReleaseFeatureEnabled(salon, key);
  return {
    key,
    label: desc.label,
    description: desc.description,
    group: desc.group,
    phase: desc.phase,
    uiGroup: releaseFeatureUiGroup(key),
    resolved,
    defaultOn: desc.defaultOn,
    source: desc.source.kind,
    overridden: resolved !== desc.defaultOn,
  };
}

/**
 * Describe every release feature for a salon, grouped for the read-only panel
 * into Base / Beta / Plan-Column. Order within each group follows
 * `RELEASE_FEATURE_KEYS` (stable registry order).
 */
export function describeReleaseFeaturesForSalon(
  salon: ReleaseFeatureSalon,
): Record<ReleaseFeatureUiGroup, ReleaseFeatureResolution[]> {
  const groups: Record<ReleaseFeatureUiGroup, ReleaseFeatureResolution[]> = {
    base: [],
    beta: [],
    plan_column: [],
  };
  for (const key of RELEASE_FEATURE_KEYS) {
    const row = describeReleaseFeatureForSalon(salon, key);
    groups[row.uiGroup].push(row);
  }
  return groups;
}

/**
 * The mapped `feature_flags` jsonb key a release feature is editable through,
 * or null when the feature is NOT per-salon-editable via the release panel.
 *
 * Only `jsonb`-sourced features are editable (PR4b-1): their state lives in a
 * boolean `feature_flags[flagKey]` that a SuperAdmin can set (true/false) or
 * reset (remove the key → fall back to the registry default). `column`
 * (voice), `plan` (billing), and `registry` (default-only) sources return null
 * — they stay read-only here:
 *   - column → editable elsewhere (Overrides / Voice AI), not the release panel,
 *   - plan   → owned by billing; toggling would conflict with `hasFeature`,
 *   - registry → no per-salon store yet (no migration in PR4b-1).
 */
export function releaseFeatureEditableFlagKey(
  key: ReleaseFeatureKey,
): string | null {
  const source = RELEASE_FEATURES[key].source;
  return source.kind === "jsonb" ? source.flagKey : null;
}

/** True when a release feature is per-salon-editable via the release panel. */
export function isReleaseFeatureEditable(key: ReleaseFeatureKey): boolean {
  return releaseFeatureEditableFlagKey(key) !== null;
}

/**
 * Whitelist of editable `feature_flags` keys, derived from the registry (not a
 * hand-maintained list). The mutation path validates set/unset requests
 * against this set so only release-owned jsonb keys can be written/removed via
 * the release panel — never a billing key or an unrelated SuperAdmin flag.
 */
export const EDITABLE_RELEASE_FLAG_KEYS: ReadonlySet<string> = new Set(
  RELEASE_FEATURE_KEYS.map(releaseFeatureEditableFlagKey).filter(
    (k): k is string => k !== null,
  ),
);
