import type { ReleaseFeatureSalon } from "@/shared/features/featureRegistry";
import {
  isFeaturePlatformDisabled,
  isReleaseFeatureVisible,
} from "@/shared/features/platformFeatureFlags";

export const COCO_SETUP_ACTIVATION_FLAG =
  "coco_setup_activation_version" as const;
export const COCO_SETUP_ACTIVATION_VERSION = 1 as const;

type CocoSetupSalon = ReleaseFeatureSalon & {
  feature_flags?: unknown;
};

function featureFlags(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * New-owner activation is separate from the legacy single-salon Guided Setup
 * QA allowlist. Existing salons remain unchanged; only registration can stamp
 * the versioned marker.
 */
export function isCocoSetupActivated(salon: CocoSetupSalon): boolean {
  return (
    featureFlags(salon.feature_flags)[COCO_SETUP_ACTIVATION_FLAG] ===
    COCO_SETUP_ACTIVATION_VERSION
  );
}

export function withCocoSetupActivation(
  existing: unknown,
): Record<string, unknown> {
  return {
    ...featureFlags(existing),
    [COCO_SETUP_ACTIVATION_FLAG]: COCO_SETUP_ACTIVATION_VERSION,
  };
}

/**
 * One authoritative visibility rule for both the disposable-QA prototype and
 * the new-owner Coco journey. The existing platform kill switch remains the
 * final authority and fails closed when its state cannot be read.
 */
export async function isCocoSetupExperienceVisible(
  salon: CocoSetupSalon,
): Promise<boolean> {
  if (!isCocoSetupActivated(salon)) {
    return isReleaseFeatureVisible(salon, "guided_admin_setup");
  }

  return !(await isFeaturePlatformDisabled("guided_admin_setup"));
}
