/**
 * Platform-wide feature kill-switches.
 *
 * Stored in the existing `platform_flags` table (key/value) under keys
 * namespaced `feature_<releaseFeatureKey>` (e.g. `feature_walkin_queue`).
 * A feature is platform-ENABLED unless an explicit row sets `enabled = false`
 * — so an absent row means "on" (safe default: nothing hidden until an
 * operator deliberately flips a kill-switch).
 *
 * Precedence (decided with product): platform OFF overrides per-salon —
 * `effective = !platformDisabled(key) && isReleaseFeatureEnabled(salon, key)`.
 * The AND is applied by `resolveFeatureVisibility` in featureRegistry.
 */

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  RELEASE_FEATURE_KEYS,
  isReleaseFeatureEnabled,
  type ReleaseFeatureKey,
  type ReleaseFeatureSalon,
} from "./featureRegistry";

const PREFIX = "feature_";

/** platform_flags row key for a release feature kill-switch. */
export function platformFeatureFlagKey(key: ReleaseFeatureKey): string {
  return `${PREFIX}${key}`;
}

/**
 * Set of release features currently DISABLED platform-wide. Absent / true
 * rows are treated as enabled. Fails open (empty set = nothing disabled) so a
 * read error never hides features for every salon at once.
 */
export async function loadPlatformDisabledFeatures(): Promise<
  Set<ReleaseFeatureKey>
> {
  const disabled = new Set<ReleaseFeatureKey>();
  let admin: ReturnType<typeof createServiceRoleClient>;
  try {
    admin = createServiceRoleClient();
  } catch {
    return disabled;
  }

  const keys = RELEASE_FEATURE_KEYS.map(platformFeatureFlagKey);
  const { data, error } = await admin
    .from("platform_flags")
    .select("key, enabled")
    .in("key", keys);

  if (error || !data) return disabled;

  for (const row of data as Array<{ key: string; enabled: boolean | null }>) {
    if (row.enabled === false && row.key.startsWith(PREFIX)) {
      disabled.add(row.key.slice(PREFIX.length) as ReleaseFeatureKey);
    }
  }
  return disabled;
}

/**
 * Current platform on/off state for every release feature (for the Superadmin
 * kill-switch UI). Defaults to ON; a `feature_<key>` row with enabled=false
 * flips it OFF.
 */
/**
 * Effective visibility for ONE feature (platform AND per-salon). Use in page
 * route guards: `if (!(await isReleaseFeatureVisible(salon, key))) notFound()`.
 */
export async function isReleaseFeatureVisible(
  salon: ReleaseFeatureSalon,
  key: ReleaseFeatureKey,
): Promise<boolean> {
  const disabled = await loadPlatformDisabledFeatures();
  return !disabled.has(key) && isReleaseFeatureEnabled(salon, key);
}

/** True when a feature is disabled platform-wide (kill-switch on). */
export async function isFeaturePlatformDisabled(
  key: ReleaseFeatureKey,
): Promise<boolean> {
  return (await loadPlatformDisabledFeatures()).has(key);
}

export async function loadPlatformFeatureStates(): Promise<
  Record<ReleaseFeatureKey, boolean>
> {
  const states = {} as Record<ReleaseFeatureKey, boolean>;
  for (const k of RELEASE_FEATURE_KEYS) states[k] = true;
  const disabled = await loadPlatformDisabledFeatures();
  for (const k of disabled) states[k] = false;
  return states;
}
