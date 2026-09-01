import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  platformDisabled: vi.fn(),
  legacyVisible: vi.fn(),
}));

vi.mock("@/shared/features/platformFeatureFlags", () => ({
  isFeaturePlatformDisabled: mocks.platformDisabled,
  isReleaseFeatureVisible: mocks.legacyVisible,
}));

import {
  isCocoSetupActivated,
  isCocoSetupExperienceVisible,
  withAuthorizedCocoSetupReceipt,
  withCocoSetupActivation,
} from "@/shared/dashboard/cocoSetupActivation";

describe("Coco Setup activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platformDisabled.mockResolvedValue(false);
    mocks.legacyVisible.mockResolvedValue(false);
  });

  it("stamps a versioned marker without removing sibling salon flags", () => {
    const flags = withCocoSetupActivation({ group_booking_enabled: true });
    expect(flags).toEqual({
      group_booking_enabled: true,
      coco_setup_activation_version: 1,
    });
    expect(isCocoSetupActivated({ feature_flags: flags })).toBe(true);
  });

  it("keeps existing and malformed salon flags inactive", () => {
    expect(isCocoSetupActivated({ feature_flags: null })).toBe(false);
    expect(
      isCocoSetupActivated({
        feature_flags: { coco_setup_activation_version: "1" },
      }),
    ).toBe(false);
  });

  it("copies only the authorized activation receipt into operational flags", () => {
    expect(
      withAuthorizedCocoSetupReceipt(
        { group_booking_enabled: true },
        {
          coco_setup_activation_version: 1,
          secret_management_flag: "must-not-leak",
        },
      ),
    ).toEqual({
      group_booking_enabled: true,
      coco_setup_activation_version: 1,
    });

    expect(
      withAuthorizedCocoSetupReceipt(
        { group_booking_enabled: true },
        { coco_setup_activation_version: "1" },
      ),
    ).toEqual({ group_booking_enabled: true });
  });

  it("uses the platform kill switch for new-owner activation", async () => {
    const salon = {
      feature_flags: { coco_setup_activation_version: 1 },
    };
    await expect(isCocoSetupExperienceVisible(salon)).resolves.toBe(true);
    expect(mocks.legacyVisible).not.toHaveBeenCalled();

    mocks.platformDisabled.mockResolvedValueOnce(true);
    await expect(isCocoSetupExperienceVisible(salon)).resolves.toBe(false);
  });

  it("preserves the legacy controlled-QA visibility path", async () => {
    const salon = { feature_flags: { guided_admin_setup_enabled: true } };
    mocks.legacyVisible.mockResolvedValueOnce(true);
    await expect(isCocoSetupExperienceVisible(salon)).resolves.toBe(true);
    expect(mocks.legacyVisible).toHaveBeenCalledWith(
      salon,
      "guided_admin_setup",
    );
    expect(mocks.platformDisabled).not.toHaveBeenCalled();
  });
});
