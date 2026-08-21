import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

import {
  isReleaseFeatureVisible,
  loadPlatformDisabledFeaturesState,
} from "@/shared/features/platformFeatureFlags";

function setPlatformResponse(
  data: Array<{ key: string; enabled: boolean }> | null,
  error: unknown = null,
) {
  mocks.createServiceRoleClient.mockReturnValue({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        in: vi.fn().mockResolvedValue({ data, error }),
      })),
    })),
  });
}

const tenant = (enabled: boolean) => ({
  feature_flags: { reports_enabled: enabled },
});

describe("Advanced Reports effective rollout boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows an enabled tenant when the platform flag is available and ON", async () => {
    setPlatformResponse([{ key: "feature_advanced_reports", enabled: true }]);

    await expect(
      isReleaseFeatureVisible(tenant(true), "advanced_reports"),
    ).resolves.toBe(true);
  });

  it("blocks global OFF even when the tenant flag is ON", async () => {
    setPlatformResponse([{ key: "feature_advanced_reports", enabled: false }]);

    await expect(
      isReleaseFeatureVisible(tenant(true), "advanced_reports"),
    ).resolves.toBe(false);
  });

  it("blocks tenant OFF even when the platform flag is ON", async () => {
    setPlatformResponse([{ key: "feature_advanced_reports", enabled: true }]);

    await expect(
      isReleaseFeatureVisible(tenant(false), "advanced_reports"),
    ).resolves.toBe(false);
  });

  it("fails closed when the platform client is unavailable", async () => {
    mocks.createServiceRoleClient.mockImplementation(() => {
      throw new Error("missing server credential");
    });

    await expect(loadPlatformDisabledFeaturesState()).resolves.toEqual({
      available: false,
      reason: "client_unavailable",
    });
    await expect(
      isReleaseFeatureVisible(tenant(true), "advanced_reports"),
    ).resolves.toBe(false);
  });

  it("fails closed when the platform query is unavailable", async () => {
    setPlatformResponse(null, { code: "PGRST002", message: "unavailable" });

    await expect(loadPlatformDisabledFeaturesState()).resolves.toEqual({
      available: false,
      reason: "query_unavailable",
    });
    await expect(
      isReleaseFeatureVisible(tenant(true), "advanced_reports"),
    ).resolves.toBe(false);
  });
});
