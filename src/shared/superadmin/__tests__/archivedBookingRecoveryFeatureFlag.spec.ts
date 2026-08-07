import { describe, expect, it } from "vitest";

import { RELEASE_FEATURES } from "@/shared/features/featureRegistry";
import { SUPERADMIN_PER_SALON_FLAGS } from "@/shared/superadmin/superadminTypes";

describe("Archived booking recovery feature flag", () => {
  it("is a default-off Beta feature backed by a per-salon JSON flag", () => {
    expect(RELEASE_FEATURES.archived_booking_recovery).toMatchObject({
      phase: "beta",
      defaultOn: false,
      group: "operations",
      source: {
        kind: "jsonb",
        flagKey: "archived_booking_recovery_enabled",
      },
    });
  });

  it("is visible and confirmation-gated in Superadmin", () => {
    const flag = SUPERADMIN_PER_SALON_FLAGS.find(
      (item) => item.key === "archived_booking_recovery_enabled",
    );

    expect(flag).toMatchObject({
      group: "operations",
      phase: "live",
      danger: true,
    });
    expect(flag?.description).toContain("không mở lại lịch cũ");
    expect(flag?.description).toContain("không tự thu tiền");
  });
});
