import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state: {
    row: Record<string, unknown> | null;
    platformEnabled: boolean;
  } = { row: null, platformEnabled: true };
  const maybeSingle = vi.fn(async () => ({ data: state.row }));
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));

  return { state, maybeSingle, eq, select, from };
});

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ from: mocks.from }),
}));
vi.mock("@/shared/features/platformFeatureFlags", async () => {
  const { isReleaseFeatureEnabled } =
    await import("@/shared/features/featureRegistry");
  return {
    isReleaseFeatureVisible: async (
      salon: Parameters<typeof isReleaseFeatureEnabled>[0],
      key: Parameters<typeof isReleaseFeatureEnabled>[1],
    ) => mocks.state.platformEnabled && isReleaseFeatureEnabled(salon, key),
  };
});

import { loadPublicNailTryOnSalon } from "@/shared/nailTryOn/publicSalon";

const baseSalon = {
  id: "salon-1",
  slug: "nail-test",
  name: "Nail Test",
  brand_color: null,
  theme_mode: "light",
  subscription_plan: "core",
  plan_override: null,
  feature_flags: { nail_tryon_enabled: true },
  voice_ai_enabled: false,
};

describe("loadPublicNailTryOnSalon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.row = null;
    mocks.state.platformEnabled = true;
  });

  it("returns an enabled nail salon", async () => {
    mocks.state.row = { ...baseSalon, vertical: "nail_salon" };

    await expect(
      loadPublicNailTryOnSalon(" Nail-Test "),
    ).resolves.toMatchObject({
      id: "salon-1",
      slug: "nail-test",
      name: "Nail Test",
      themeMode: "light",
    });
    expect(mocks.eq).toHaveBeenCalledWith("slug", "nail-test");
  });

  it("blocks a non-nail salon even when its rollout flag is on", async () => {
    mocks.state.row = { ...baseSalon, vertical: "head_spa" };

    await expect(loadPublicNailTryOnSalon("nail-test")).resolves.toBeNull();
  });

  it("blocks a nail salon when its rollout flag is off", async () => {
    mocks.state.row = {
      ...baseSalon,
      vertical: "nail_salon",
      feature_flags: { nail_tryon_enabled: false },
    };

    await expect(loadPublicNailTryOnSalon("nail-test")).resolves.toBeNull();
  });

  it("blocks the public surface when the platform kill switch is off", async () => {
    mocks.state.row = { ...baseSalon, vertical: "nail_salon" };
    mocks.state.platformEnabled = false;

    await expect(loadPublicNailTryOnSalon("nail-test")).resolves.toBeNull();
  });

  it("loads the vertical needed by the eligibility gate", async () => {
    mocks.state.row = { ...baseSalon, vertical: "nail_salon" };

    await loadPublicNailTryOnSalon("nail-test");

    expect(mocks.select).toHaveBeenCalledWith(
      expect.stringContaining("vertical"),
    );
  });
});
