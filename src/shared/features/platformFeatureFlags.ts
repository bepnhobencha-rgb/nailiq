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
const FAIL_CLOSED_WHEN_PLATFORM_UNAVAILABLE = new Set<ReleaseFeatureKey>([
  "guided_admin_setup",
  "ai_text_receptionist",
  "advanced_reports",
  "multi_service_booking",
  "smart_checkout",
  "loyalty",
]);
/** New high-risk rollouts are OFF until an explicit platform row says ON. */
const PLATFORM_EXPLICIT_ON_REQUIRED = new Set<ReleaseFeatureKey>([
  "multi_service_booking",
  "smart_checkout",
  "loyalty",
]);

type PlatformFeatureControlState =
  | {
      available: true;
      disabled: Set<ReleaseFeatureKey>;
      explicitlyEnabled: Set<ReleaseFeatureKey>;
    }
  | {
      available: false;
      reason: "client_unavailable" | "query_unavailable";
    };

export type PlatformDisabledFeaturesState =
  | { available: true; disabled: Set<ReleaseFeatureKey> }
  | {
      available: false;
      reason: "client_unavailable" | "query_unavailable";
    };

/** platform_flags row key for a release feature kill-switch. */
export function platformFeatureFlagKey(key: ReleaseFeatureKey): string {
  return `${PREFIX}${key}`;
}

async function loadPlatformFeatureControlState(): Promise<PlatformFeatureControlState> {
  const existing = platformFeatureControlFlight;
  if (existing) return existing;

  const flight = queryPlatformFeatureControlState();
  platformFeatureControlFlight = flight;
  try {
    return await flight;
  } finally {
    if (platformFeatureControlFlight === flight) {
      platformFeatureControlFlight = null;
    }
  }
}

let platformFeatureControlFlight: Promise<PlatformFeatureControlState> | null =
  null;

async function queryPlatformFeatureControlState(): Promise<PlatformFeatureControlState> {
  const disabled = new Set<ReleaseFeatureKey>();
  const explicitlyEnabled = new Set<ReleaseFeatureKey>();
  let admin: ReturnType<typeof createServiceRoleClient>;
  try {
    admin = createServiceRoleClient();
  } catch {
    return { available: false, reason: "client_unavailable" };
  }

  const keys = RELEASE_FEATURE_KEYS.map(platformFeatureFlagKey);
  try {
    const { data, error } = await admin
      .from("platform_flags")
      .select("key, enabled")
      .in("key", keys);

    if (error || !data) {
      return { available: false, reason: "query_unavailable" };
    }

    for (const row of data as Array<{ key: string; enabled: boolean | null }>) {
      if (!row.key.startsWith(PREFIX)) continue;
      const key = row.key.slice(PREFIX.length) as ReleaseFeatureKey;
      if (row.enabled === false) disabled.add(key);
      if (row.enabled === true) explicitlyEnabled.add(key);
    }

    return { available: true, disabled, explicitlyEnabled };
  } catch {
    return { available: false, reason: "query_unavailable" };
  }
}

/**
 * Load platform-disabled features while preserving whether the authoritative
 * platform state was actually available. An absent row is a successful read
 * and therefore means platform ON; client/query failures are distinct.
 */
export async function loadPlatformDisabledFeaturesState(): Promise<PlatformDisabledFeaturesState> {
  const state = await loadPlatformFeatureControlState();
  return state.available
    ? { available: true, disabled: state.disabled }
    : state;
}

/**
 * Set of release features currently DISABLED platform-wide.
 *
 * Existing release features retain the historical fail-open behavior when
 * the platform state is unavailable. QA rollout and paid-provider surfaces
 * fail closed until the global state can be read. A successful query with no
 * row still returns an empty set and therefore means global ON.
 */
export async function loadPlatformDisabledFeatures(): Promise<
  Set<ReleaseFeatureKey>
> {
  const state = await loadPlatformDisabledFeaturesState();
  return state.available
    ? state.disabled
    : new Set(FAIL_CLOSED_WHEN_PLATFORM_UNAVAILABLE);
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
  // A tenant-local OFF can never be overturned by the platform flag. Resolve
  // that side first so default-off/disabled surfaces do not issue an
  // authoritative platform read on every dashboard document.
  if (!isReleaseFeatureEnabled(salon, key)) return false;

  if (PLATFORM_EXPLICIT_ON_REQUIRED.has(key)) {
    const state = await loadPlatformFeatureControlState();
    return (
      state.available &&
      state.explicitlyEnabled.has(key) &&
      !state.disabled.has(key) &&
      true
    );
  }
  const disabled = await loadPlatformDisabledFeatures();
  return !disabled.has(key);
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
