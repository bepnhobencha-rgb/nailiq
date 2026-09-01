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
 * The member operational profile intentionally strips non-boolean feature
 * flags. Coco's versioned activation receipt is a number, so Owner/Admin
 * dashboard contexts must copy only that one bounded value from the already
 * authorized management projection. Never merge the full management JSON
 * into the operational context.
 */
export function withAuthorizedCocoSetupReceipt(
  operationalFlags: unknown,
  managementFlags: unknown,
): Record<string, unknown> | null {
  const operational = featureFlags(operationalFlags);
  const activation = featureFlags(managementFlags)[COCO_SETUP_ACTIVATION_FLAG];

  if (activation !== COCO_SETUP_ACTIVATION_VERSION) {
    return Object.keys(operational).length > 0 ? operational : null;
  }

  return {
    ...operational,
    [COCO_SETUP_ACTIVATION_FLAG]: COCO_SETUP_ACTIVATION_VERSION,
  };
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
