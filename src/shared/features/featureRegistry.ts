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
  | "experimental_realtime";

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
    defaultOn: false,
    source: { kind: "registry" },
    description: "Marketing / SMS campaigns.",
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
