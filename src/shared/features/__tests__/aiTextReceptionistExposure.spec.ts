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
  RELEASE_FEATURES,
  isReleaseFeatureEnabled,
} from "@/shared/features/featureRegistry";
import {
  isReleaseFeatureVisible,
  loadPlatformDisabledFeaturesState,
} from "@/shared/features/platformFeatureFlags";

const FEATURE = "ai_text_receptionist" as const;

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

describe("AI Text Receptionist effective exposure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is a tenant-editable Beta feature that defaults OFF", () => {
    expect(RELEASE_FEATURES[FEATURE]).toMatchObject({
      key: FEATURE,
      phase: "beta",
      defaultOn: false,
      source: {
        kind: "jsonb",
        flagKey: "ai_text_receptionist_enabled",
      },
    });
    expect(isReleaseFeatureEnabled({}, FEATURE)).toBe(false);
    expect(
      isReleaseFeatureEnabled(
        { feature_flags: { ai_text_receptionist_enabled: true } },
        FEATURE,
      ),
    ).toBe(true);
    expect(
      isReleaseFeatureEnabled(
        { feature_flags: { ai_text_receptionist_enabled: false } },
        FEATURE,
      ),
    ).toBe(false);
  });

  it.each([
    { platform: false, tenant: true, expected: false },
    { platform: true, tenant: false, expected: false },
    { platform: true, tenant: true, expected: true },
  ])(
    "requires platform=$platform AND tenant=$tenant",
    async ({ platform, tenant, expected }) => {
      setPlatformResponse([
        { key: "feature_ai_text_receptionist", enabled: platform },
      ]);

      await expect(
        isReleaseFeatureVisible(
          {
            feature_flags: { ai_text_receptionist_enabled: tenant },
          },
          FEATURE,
        ),
      ).resolves.toBe(expected);
    },
  );

  it("fails closed when the platform state cannot be constructed", async () => {
    mocks.createServiceRoleClient.mockImplementation(() => {
      throw new Error("platform credential unavailable");
    });

    await expect(loadPlatformDisabledFeaturesState()).resolves.toEqual({
      available: false,
      reason: "client_unavailable",
    });
    await expect(
      isReleaseFeatureVisible(
        { feature_flags: { ai_text_receptionist_enabled: true } },
        FEATURE,
      ),
    ).resolves.toBe(false);
  });

  it("fails closed when the platform query is unavailable", async () => {
    setPlatformResponse(null, { code: "PGRST002", message: "unavailable" });

    await expect(loadPlatformDisabledFeaturesState()).resolves.toEqual({
      available: false,
      reason: "query_unavailable",
    });
    await expect(
      isReleaseFeatureVisible(
        { feature_flags: { ai_text_receptionist_enabled: true } },
        FEATURE,
      ),
    ).resolves.toBe(false);
  });
});

describe("AI Text Receptionist public and route boundaries", () => {
  const pagePath = "src/app/[slug]/page.tsx";
  const loaderPath = "src/shared/booking/loadBookingServices.ts";
  const routePath = "src/app/api/chat/booking/route.ts";
  const boundaryPath = "src/shared/booking/bookingChatApiBoundary.ts";

  it("renders the public widget only from an effective platform-and-tenant result", () => {
    const page = readFileSync(resolve(process.cwd(), pagePath), "utf8");
    const loader = readFileSync(resolve(process.cwd(), loaderPath), "utf8");

    const pageChecksEffectiveFlag =
      page.includes("loadAuthorizedBookingChatContext") &&
      page.includes("load.salon.aiTextReceptionistEnabled");
    const loaderChecksEffectiveFlag =
      loader.includes("isReleaseFeatureVisible") &&
      loader.includes('"ai_text_receptionist"');

    expect(pageChecksEffectiveFlag || loaderChecksEffectiveFlag).toBe(true);
    expect(page).toContain("<BookingChatWidget");
    expect(page).toContain("loadAuthorizedBookingChatContext(load.salon.id)");
    expect(page).toContain("bookingChatContext?.ok === true");
    expect(page).toMatch(
      /\{(?:bookingChatVisible|aiTextReceptionistVisible|load\.salon\.aiTextReceptionistEnabled)\s*\?\s*\(/,
    );
  });

  it("does not render the widget from a raw ANTHROPIC_API_KEY-only condition", () => {
    const page = readFileSync(resolve(process.cwd(), pagePath), "utf8");

    expect(page).not.toMatch(
      /\{\s*process\.env\.ANTHROPIC_API_KEY(?:\?\.trim\(\))?\s*\?\s*\(/,
    );
    expect(page).not.toMatch(/ANTHROPIC_API_KEY[\s\S]{0,80}<BookingChatWidget/);
  });

  it("independently checks the same effective feature before constructing the provider", () => {
    const route = readFileSync(resolve(process.cwd(), routePath), "utf8");
    const boundary = readFileSync(resolve(process.cwd(), boundaryPath), "utf8");
    const authorizedContext = route.indexOf(
      "await loadAuthorizedBookingChatContext(",
    );
    const providerConstruction = route.indexOf("const ai = getClient()");

    expect(boundary).toContain('from "@/shared/features/platformFeatureFlags"');
    expect(boundary).toContain("isReleaseFeatureEnabled(");
    expect(boundary).toContain("canRunAutonomousAiForTenant(");
    expect(boundary).toContain("loadPlatformDisabledFeaturesState()");
    expect(boundary).toContain("if (!platform.available)");
    expect(boundary).toContain(
      'platform.disabled.has("ai_text_receptionist")',
    );
    expect(boundary).toContain('"ai_text_receptionist"');
    expect(boundary).toContain("profile_complete, feature_flags");
    expect(route).toContain("loadAuthorizedBookingChatContext");
    expect(authorizedContext).toBeGreaterThanOrEqual(0);
    expect(providerConstruction).toBeGreaterThan(authorizedContext);
  });
});
