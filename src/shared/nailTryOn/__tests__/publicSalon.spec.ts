import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  maybeSingle: vi.fn(),
  select: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: mocks.select,
    }),
  }),
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
    ...overrides,
  };
}

describe("public Nail Try-On salon boundary", () => {
  beforeEach(() => {
    mocks.maybeSingle.mockReset();
    mocks.select.mockReset();
    mocks.select.mockReturnValue({
      eq: () => ({ maybeSingle: mocks.maybeSingle }),
    });
  });

  it("loads an active, booking-ready salon with Try-On enabled", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: salonRow(), error: null });

    await expect(loadPublicNailTryOnSalon(" NailIQ-QA-2026-07-26 ")).resolves.toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      slug: "nailiq-qa-2026-07-26",
      name: "NailIQ QA",
      brandColor: "#c6a15b",
      themeMode: "light",
    });
  });

  it("rejects an archived salon even if its old Try-On flag is still enabled", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: salonRow({ archived_at: "2026-08-11T03:00:58.000Z" }),
      error: null,
    });

    await expect(loadPublicNailTryOnSalon("tech-nails")).resolves.toBeNull();
  });

  it("rejects an incomplete salon so the booking handoff cannot dead-end", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: salonRow({ profile_complete: false }),
      error: null,
    });

    await expect(loadPublicNailTryOnSalon("qa-draft")).resolves.toBeNull();
  });

  it("rejects an active salon when Try-On is disabled", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: salonRow({ feature_flags: { nail_tryon_enabled: false } }),
      error: null,
    });

    await expect(loadPublicNailTryOnSalon("qa-disabled")).resolves.toBeNull();
  });
});
