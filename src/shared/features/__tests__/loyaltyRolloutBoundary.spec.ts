import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createServiceRoleClient: vi.fn() }));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

import { isReleaseFeatureVisible } from "../platformFeatureFlags";

function platformRows(
  rows: Array<{ key: string; enabled: boolean }> | null,
  error: unknown = null,
) {
  mocks.createServiceRoleClient.mockReturnValue({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        in: vi.fn().mockResolvedValue({ data: rows, error }),
      })),
    })),
  });
}

const salon = (enabled: boolean) => ({
  feature_flags: { loyalty_enabled: enabled },
});

describe("loyalty dual default-OFF gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires explicit platform ON and tenant ON", async () => {
    platformRows([{ key: "feature_loyalty", enabled: true }]);
    await expect(isReleaseFeatureVisible(salon(true), "loyalty")).resolves.toBe(
      true,
    );

    platformRows([{ key: "feature_loyalty", enabled: false }]);
    await expect(isReleaseFeatureVisible(salon(true), "loyalty")).resolves.toBe(
      false,
    );

    platformRows([{ key: "feature_loyalty", enabled: true }]);
    await expect(isReleaseFeatureVisible(salon(false), "loyalty")).resolves.toBe(
      false,
    );
  });

  it("fails closed when platform state is absent or unavailable", async () => {
    platformRows([]);
    await expect(isReleaseFeatureVisible(salon(true), "loyalty")).resolves.toBe(
      false,
    );

    platformRows(null, { message: "unavailable" });
    await expect(isReleaseFeatureVisible(salon(true), "loyalty")).resolves.toBe(
      false,
    );
  });
});
