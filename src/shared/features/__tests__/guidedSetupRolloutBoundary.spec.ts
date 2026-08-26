import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

import {
  resolveGuidedDashboardRoot,
  resolveGuidedSetupStage,
} from "@/shared/dashboard/guidedSetup";
import {
  isReleaseFeatureVisible,
  loadPlatformDisabledFeaturesState,
} from "../platformFeatureFlags";

function setPlatformResponse(
  data: Array<{ key: string; enabled: boolean }> | null,
  error: unknown = null,
) {
  mocks.createServiceRoleClient.mockReturnValue({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        in: vi.fn().mockResolvedValue({
          data,
          error,
        }),
      })),
    })),
  });
}

function setPlatformGuidedFlag(enabled: boolean) {
  setPlatformResponse([{ key: "feature_guided_admin_setup", enabled }]);
}

describe("Guided Setup effective rollout boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      name: "global OFF and tenant ON",
      globalEnabled: false,
      tenantEnabled: true,
      effective: false,
      root: "legacy",
      stage: "disabled",
    },
    {
      name: "global ON and tenant OFF",
      globalEnabled: true,
      tenantEnabled: false,
      effective: false,
      root: "legacy",
      stage: "disabled",
    },
    {
      name: "global ON and tenant ON",
      globalEnabled: true,
      tenantEnabled: true,
      effective: true,
      root: "setup",
      stage: "incomplete",
    },
  ] as const)(
    "$name resolves every Guided surface from the same effective flag",
    async ({ globalEnabled, tenantEnabled, effective, root, stage }) => {
      setPlatformGuidedFlag(globalEnabled);

      const enabled = await isReleaseFeatureVisible(
        {
          feature_flags: {
            guided_admin_setup_enabled: tenantEnabled,
          },
        },
        "guided_admin_setup",
      );

      expect(enabled).toBe(effective);
      expect(resolveGuidedDashboardRoot(enabled, false)).toBe(root);
      expect(resolveGuidedSetupStage(enabled, false)).toBe(stage);
    },
  );

  it("fails Guided closed when the service client cannot be constructed", async () => {
    mocks.createServiceRoleClient.mockImplementation(() => {
      throw new Error("missing server credential");
    });

    await expect(loadPlatformDisabledFeaturesState()).resolves.toEqual({
      available: false,
      reason: "client_unavailable",
    });
    await expect(
      isReleaseFeatureVisible(
        { feature_flags: { guided_admin_setup_enabled: true } },
        "guided_admin_setup",
      ),
    ).resolves.toBe(false);
  });

  it("fails Guided closed on a returned platform query error only", async () => {
    setPlatformResponse(null, { code: "PGRST002", message: "unavailable" });

    await expect(loadPlatformDisabledFeaturesState()).resolves.toEqual({
      available: false,
      reason: "query_unavailable",
    });
    await expect(
      isReleaseFeatureVisible(
        { feature_flags: { guided_admin_setup_enabled: true } },
        "guided_admin_setup",
      ),
    ).resolves.toBe(false);
    await expect(
      isReleaseFeatureVisible(
        { feature_flags: { group_booking_enabled: true } },
        "group_booking",
      ),
    ).resolves.toBe(true);
  });

  it("treats a successful absent row as global ON", async () => {
    setPlatformResponse([]);

    const state = await loadPlatformDisabledFeaturesState();
    expect(state.available).toBe(true);
    if (state.available) expect([...state.disabled]).toEqual([]);
    await expect(
      isReleaseFeatureVisible(
        { feature_flags: { guided_admin_setup_enabled: true } },
        "guided_admin_setup",
      ),
    ).resolves.toBe(true);
    await expect(
      isReleaseFeatureVisible(
        { feature_flags: { guided_admin_setup_enabled: false } },
        "guided_admin_setup",
      ),
    ).resolves.toBe(false);
  });
});

const effectiveGateFiles = [
  "src/app/dashboard/[slug]/page.tsx",
  "src/app/dashboard/[slug]/no-show-protection/page.tsx",
  "src/app/dashboard/[slug]/settings/page.tsx",
  "src/app/dashboard/[slug]/setup/address/page.tsx",
  "src/app/dashboard/[slug]/setup/hours/page.tsx",
  "src/app/dashboard/[slug]/setup/services/page.tsx",
  "src/app/dashboard/[slug]/setup/staff/page.tsx",
  "src/shared/dashboard/loadGoLiveReadiness.ts",
] as const;

describe("Guided Setup server entry points", () => {
  it.each(effectiveGateFiles)(
    "uses the platform-and-tenant resolver in %s",
    (file) => {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source).toContain(
        'from "@/shared/features/platformFeatureFlags"',
      );
      expect(source).toMatch(
        /isReleaseFeatureVisible\([\s\S]*?"guided_admin_setup"/,
      );
    },
  );

  it("keeps the preview page on the authenticated authoritative loader", () => {
    const page = readFileSync(
      resolve(
        process.cwd(),
        "src/app/dashboard/[slug]/setup/preview/page.tsx",
      ),
      "utf8",
    );
    const loader = readFileSync(
      resolve(
        process.cwd(),
        "src/shared/dashboard/loadGuidedBookingPreview.ts",
      ),
      "utf8",
    );

    expect(page).toContain("loadGuidedBookingPreview(slug)");
    expect(loader).toContain(
      'from "@/shared/features/platformFeatureFlags"',
    );
    expect(loader).toMatch(
      /await isReleaseFeatureVisible\([\s\S]*?"guided_admin_setup"/,
    );
  });

  it("keeps indirect setup, readiness, shell, and action surfaces on authoritative results", () => {
    const setupIndex = readFileSync(
      resolve(process.cwd(), "src/app/dashboard/[slug]/setup/page.tsx"),
      "utf8",
    );
    const readinessPage = readFileSync(
      resolve(
        process.cwd(),
        "src/app/dashboard/[slug]/settings/readiness/page.tsx",
      ),
      "utf8",
    );
    const layout = readFileSync(
      resolve(process.cwd(), "src/app/dashboard/[slug]/layout.tsx"),
      "utf8",
    );
    const action = readFileSync(
      resolve(
        process.cwd(),
        "src/shared/dashboard/goLiveAttestationAction.ts",
      ),
      "utf8",
    );

    expect(setupIndex).toContain("loadGoLiveReadiness(slug)");
    expect(setupIndex).toContain("result.guidedSetupEnabled");
    expect(readinessPage).toContain("loadGoLiveReadiness(slug)");
    expect(readinessPage).toContain("result.guidedSetupEnabled");
    expect(layout).toContain("resolveFeatureVisibility(");
    expect(layout).toContain("releaseFeatures.guided_admin_setup");
    expect(action).toContain("loadGoLiveReadiness(slug)");
    expect(action).toContain("loaded.guidedSetupEnabled");
  });
});
