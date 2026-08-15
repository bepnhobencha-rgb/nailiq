import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state: { rows: Array<{ key: string; enabled: boolean }> } = {
    rows: [],
  };
  const inFilter = vi.fn(async () => ({ data: state.rows, error: null }));
  const select = vi.fn(() => ({ in: inFilter }));
  const from = vi.fn(() => ({ select }));
  return { state, inFilter, select, from };
});

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ from: mocks.from }),
}));

import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";

describe("platform release-feature kill switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.rows = [];
  });

  it("allows an explicitly enabled salon when no platform override exists", async () => {
    await expect(
      isReleaseFeatureVisible(
        { feature_flags: { nail_tryon_enabled: true } },
        "nail_tryon",
      ),
    ).resolves.toBe(true);
  });

  it("overrides the salon flag when Nail Try-On is disabled platform-wide", async () => {
    mocks.state.rows = [{ key: "feature_nail_tryon", enabled: false }];

    await expect(
      isReleaseFeatureVisible(
        { feature_flags: { nail_tryon_enabled: true } },
        "nail_tryon",
      ),
    ).resolves.toBe(false);
  });
});
