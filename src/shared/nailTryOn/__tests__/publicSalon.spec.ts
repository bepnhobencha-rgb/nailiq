import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eq: vi.fn(),
  isReleaseFeatureVisible: vi.fn(),
  maybeSingle: vi.fn(),
  select: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    from: () => ({ select: mocks.select }),
  }),
}));
vi.mock("@/shared/features/platformFeatureFlags", () => ({
  isReleaseFeatureVisible: mocks.isReleaseFeatureVisible,
}));

import { loadPublicNailTryOnSalon } from "../publicSalon";

function salonRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    slug: "nailiq-qa-2026-07-26",
    name: "NailIQ QA",
    archived_at: null,
    profile_complete: true,
    brand_color: "#c6a15b",
    theme_mode: "light",
    subscription_plan: "free",
    plan_override: null,
    feature_flags: { nail_tryon_enabled: true },
    voice_ai_enabled: false,
    vertical: "nail_salon",
    ...overrides,
  };
}

describe("public Nail Try-On salon boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eq.mockReturnValue({ maybeSingle: mocks.maybeSingle });
    mocks.select.mockReturnValue({ eq: mocks.eq });
    mocks.isReleaseFeatureVisible.mockResolvedValue(true);
  });

  it("loads an active, booking-ready nail salon when both release gates allow it", async () => {
    const row = salonRow();
    mocks.maybeSingle.mockResolvedValue({ data: row, error: null });

    await expect(
      loadPublicNailTryOnSalon(" NailIQ-QA-2026-07-26 "),
    ).resolves.toEqual({
      id: row.id,
      slug: row.slug,
      name: row.name,
      brandColor: row.brand_color,
      themeMode: "light",
    });
    expect(mocks.eq).toHaveBeenCalledWith("slug", "nailiq-qa-2026-07-26");
    expect(mocks.isReleaseFeatureVisible).toHaveBeenCalledWith(row, "nail_tryon");
  });

  it.each([
    ["archived", { archived_at: "2026-08-11T03:00:58.000Z" }],
    ["incomplete", { profile_complete: false }],
    ["non-nail", { vertical: "head_spa" }],
  ])("rejects a %s salon before consulting the platform flag", async (_label, patch) => {
    mocks.maybeSingle.mockResolvedValue({ data: salonRow(patch), error: null });

    await expect(loadPublicNailTryOnSalon("qa-salon")).resolves.toBeNull();
    expect(mocks.isReleaseFeatureVisible).not.toHaveBeenCalled();
  });

  it("lets the platform kill switch override the salon flag", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: salonRow(), error: null });
    mocks.isReleaseFeatureVisible.mockResolvedValue(false);

    await expect(loadPublicNailTryOnSalon("qa-disabled")).resolves.toBeNull();
  });
});
