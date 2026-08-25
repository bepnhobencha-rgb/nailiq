/**
 * Server-side enforcement of release feature flags (PR3).
 *
 * `requireReleaseFeatureEnabled(slug, key)` is the single gate that
 * route pages and server actions call to refuse access to a Beta surface
 * whose release flag is OFF. It mirrors the ergonomics of
 * `requirePremiumSalon` (loyaltyActions.ts) — one auth resolve + one salon
 * fetch — but checks a *release* flag (`isReleaseFeatureEnabled`), never
 * billing tiers. Release and billing stay separate (see featureRegistry).
 *
 * Returns a discriminated result instead of throwing so server actions can
 * surface `feature_not_enabled` cleanly; route pages translate the failure
 * into `notFound()` themselves.
 */

import "server-only";

import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
import {
  isReleaseFeatureEnabled,
  type ReleaseFeatureKey,
} from "@/shared/features/featureRegistry";

/** The salon flag inputs the resolver needs (a subset of the row). */
export type ReleaseFeatureSalonRow = {
  id: string;
  subscription_plan: string | null;
  plan_override: string | null;
  feature_flags: unknown;
  voice_ai_enabled: boolean | null;
  vertical?: string | null;
};

export type RequireReleaseFeatureResult =
  | { ok: true; salon: ReleaseFeatureSalonRow }
  | { ok: false; error: "unauthorized" | "salon_not_found" | "feature_not_enabled" };

/**
 * Authorize the caller against `slug` AND require `featureKey` to be enabled.
 *
 *  - `unauthorized`        — no membership / demo-gate failed.
 *  - `salon_not_found`     — salon row vanished between auth and fetch.
 *  - `feature_not_enabled` — the release flag resolves OFF for this salon.
 *
 * On success the resolved salon row (with flag inputs) is returned so callers
 * can avoid a second round-trip.
 */
export async function requireReleaseFeatureEnabled(
  slug: string,
  featureKey: ReleaseFeatureKey,
): Promise<RequireReleaseFeatureResult> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false, error: "unauthorized" };

  const salon = resolved.salon as ReleaseFeatureSalonRow;

  if (!isReleaseFeatureEnabled(salon, featureKey)) {
    return { ok: false, error: "feature_not_enabled" };
  }

  return { ok: true, salon };
}
