import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createServiceRoleClient: vi.fn() }));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";

function platformRows(rows: Array<{ key: string; enabled: boolean }> | null, error: unknown = null) {
  mocks.createServiceRoleClient.mockReturnValue({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        in: vi.fn().mockResolvedValue({ data: rows, error }),
      })),
    })),
  });
}

const salon = (enabled: boolean) => ({
  feature_flags: { multi_service_booking_enabled: enabled },
});

describe("multi-service dual default-OFF gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires both an explicit platform ON row and salon ON", async () => {
    platformRows([{ key: "feature_multi_service_booking", enabled: true }]);
    await expect(
      isReleaseFeatureVisible(salon(true), "multi_service_booking"),
    ).resolves.toBe(true);

    platformRows([{ key: "feature_multi_service_booking", enabled: false }]);
    await expect(
      isReleaseFeatureVisible(salon(true), "multi_service_booking"),
    ).resolves.toBe(false);

    platformRows([{ key: "feature_multi_service_booking", enabled: true }]);
    await expect(
      isReleaseFeatureVisible(salon(false), "multi_service_booking"),
    ).resolves.toBe(false);
  });

  it("treats an absent platform row and platform read failures as OFF", async () => {
    platformRows([]);
    await expect(
      isReleaseFeatureVisible(salon(true), "multi_service_booking"),
    ).resolves.toBe(false);

    platformRows(null, { message: "unavailable" });
    await expect(
      isReleaseFeatureVisible(salon(true), "multi_service_booking"),
    ).resolves.toBe(false);

    mocks.createServiceRoleClient.mockImplementation(() => {
      throw new Error("missing credentials");
    });
    await expect(
      isReleaseFeatureVisible(salon(true), "multi_service_booking"),
    ).resolves.toBe(false);
  });

  it.each(["Hi-Lite Head Spa", "Hi-Lite Studio"])(
    "keeps %s hidden while its tenant gate remains OFF",
    async (name) => {
      platformRows([{ key: "feature_multi_service_booking", enabled: true }]);
      expect(name).toMatch(/^Hi-Lite (?:Head Spa|Studio)$/);
      await expect(
        isReleaseFeatureVisible(salon(false), "multi_service_booking"),
      ).resolves.toBe(false);
    },
  );
});
