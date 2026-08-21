import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
  getDashboardWriteClient: vi.fn(),
  getSalonDomain: vi.fn(),
  isReleaseFeatureVisible: vi.fn(),
  loadOwnerSalons: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
  resolveSalonForDashboard: vi.fn(),
  requireReleaseFeatureEnabled: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
}));
vi.mock("@/shared/dashboard/setupActions", () => ({
  getDashboardWriteClient: mocks.getDashboardWriteClient,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock("@/shared/features/requireReleaseFeature", () => ({
  requireReleaseFeatureEnabled: mocks.requireReleaseFeatureEnabled,
}));
vi.mock("@/shared/dashboard/domainActions", () => ({
  getSalonDomain: mocks.getSalonDomain,
}));
vi.mock("@/shared/dashboard/salonOwnerActions", () => ({
  loadOwnerSalons: mocks.loadOwnerSalons,
  resolveSalonForDashboard: mocks.resolveSalonForDashboard,
}));
vi.mock("@/shared/features/platformFeatureFlags", () => ({
  isReleaseFeatureVisible: mocks.isReleaseFeatureVisible,
}));
vi.mock("@/shared/features/featureRegistry", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/shared/features/featureRegistry")
  >();
  return { ...original, isReleaseFeatureEnabled: vi.fn(() => true) };
});
vi.mock("@/components/dashboard/SalonSettingsHub", () => ({
  SalonSettingsHub: () => "SALON_SETTINGS_HUB",
}));
vi.mock("@/components/dashboard/GuidedSetupReturnCard", () => ({
  GuidedSetupReturnCard: () => "GUIDED_SETUP_RETURN",
}));
vi.mock("@/components/dashboard/NailDesignCatalogManager", () => ({
  NailDesignCatalogManager: () => "NAIL_DESIGN_CATALOG_MANAGER",
}));
vi.mock("@/components/dashboard/VoiceSettingsForm", () => ({
  VoiceSettingsForm: () => "VOICE_SETTINGS_FORM",
}));
vi.mock("@/components/dashboard/VoicePhoneSetup", () => ({
  VoicePhoneSetup: () => "VOICE_PHONE_SETUP",
}));
vi.mock("@/components/ai/ManagerBriefingChat", () => ({
  ManagerBriefingChat: () => "MANAGER_BRIEFING_CHAT",
}));

import SalonSettingsPage from "@/app/dashboard/[slug]/settings/page";
import NailTryOnSetupPage from "@/app/dashboard/[slug]/setup/nail-tryon/page";
import ManagerBriefingPage from "@/app/dashboard/[slug]/setup/manager-briefing/page";
import VoiceSetupPage from "@/app/dashboard/[slug]/setup/voice/page";
import { loadGroupBookingSettings } from "@/shared/booking/groupBookingSettingsActions";
import { loadTaxSettings } from "@/shared/dashboard/taxSettingsActions";

type SalonRole = "owner" | "admin" | "senior" | "receptionist" | "nail_tech";

class EmptyQuery {
  select(): this { return this; }
  eq(): this { return this; }
  is(): this { return this; }
  order(): this { return this; }
  maybeSingle(): Promise<{ data: Record<string, never>; error: null }> {
    return Promise.resolve({ data: {}, error: null });
  }
  single(): Promise<{ data: Record<string, never>; error: null }> {
    return Promise.resolve({ data: {}, error: null });
  }
  then<TResult1 = { data: unknown[]; error: null }, TResult2 = never>(
    onFulfilled?:
      | ((value: { data: unknown[]; error: null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve({ data: [], error: null }).then(
      onFulfilled,
      onRejected,
    );
  }
}

function routeContext(role: SalonRole) {
  return {
    role,
    kind: "member" as const,
    userId: "user-1",
    salon: {
      id: "salon-1",
      name: "QA Salon",
      slug: "qa-salon",
    },
    supabase: {
      from: vi.fn(() => new EmptyQuery()),
      rpc: vi.fn().mockResolvedValue({
        data: {
          success: true,
          code: "loaded",
          contract_version: 1,
          salon_id: "salon-1",
          role,
          settings: {},
        },
        error: null,
      }),
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { email: "owner@example.test" } } }),
      },
    },
  };
}

function serviceRoleClient() {
  return {
    from: vi.fn(() => new EmptyQuery()),
    storage: {
      from: vi.fn(() => ({
        createSignedUrl: vi.fn().mockResolvedValue({ data: null }),
      })),
    },
  };
}

describe("salon admin deep-link role matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redirect.mockImplementation((href: string) => {
      throw new Error(`REDIRECT:${href}`);
    });
    mocks.notFound.mockImplementation(() => {
      throw new Error("NOT_FOUND");
    });
    mocks.getSalonDomain.mockResolvedValue({ status: "none" });
    mocks.isReleaseFeatureVisible.mockResolvedValue(false);
    mocks.loadOwnerSalons.mockResolvedValue([]);
    mocks.requireReleaseFeatureEnabled.mockResolvedValue({
      ok: true,
      salon: { id: "salon-1" },
    });
    mocks.createServiceRoleClient.mockImplementation(serviceRoleClient);
  });

  it.each(["owner", "admin"] as const)(
    "allows a same-salon %s to load both management pages",
    async (role) => {
      const ctx = routeContext(role);
      mocks.getDashboardWriteClient.mockResolvedValue(ctx);

      await expect(
        SalonSettingsPage({
          params: Promise.resolve({ slug: "qa-salon" }),
          searchParams: Promise.resolve({}),
        }),
      ).resolves.toBeTruthy();
      await expect(
        NailTryOnSetupPage({
          params: Promise.resolve({ slug: "qa-salon" }),
        }),
      ).resolves.toBeTruthy();
      await expect(
        ManagerBriefingPage({
          params: Promise.resolve({ slug: "qa-salon" }),
        }),
      ).resolves.toBeTruthy();
      await expect(
        VoiceSetupPage({
          params: Promise.resolve({ slug: "qa-salon" }),
        }),
      ).resolves.toBeTruthy();

      expect(ctx.supabase.from).not.toHaveBeenCalled();
      expect(ctx.supabase.rpc).toHaveBeenCalledOnce();
      expect(mocks.requireReleaseFeatureEnabled).toHaveBeenCalledWith(
        "qa-salon",
        "nail_tryon",
      );
      expect(mocks.createServiceRoleClient).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["senior", "receptionist", "nail_tech"] as const)(
    "redirects a %s before any settings or service-role read",
    async (role) => {
      const settingsCtx = routeContext(role);
      mocks.getDashboardWriteClient.mockResolvedValueOnce(settingsCtx);
      await expect(
        SalonSettingsPage({
          params: Promise.resolve({ slug: "qa-salon" }),
          searchParams: Promise.resolve({}),
        }),
      ).rejects.toThrow("REDIRECT:/dashboard/qa-salon");
      expect(settingsCtx.supabase.from).not.toHaveBeenCalled();
      expect(settingsCtx.supabase.rpc).not.toHaveBeenCalled();
      expect(mocks.getSalonDomain).not.toHaveBeenCalled();

      const nailTryOnCtx = routeContext(role);
      mocks.getDashboardWriteClient.mockResolvedValueOnce(nailTryOnCtx);
      await expect(
        NailTryOnSetupPage({
          params: Promise.resolve({ slug: "qa-salon" }),
        }),
      ).rejects.toThrow("REDIRECT:/dashboard/qa-salon");
      expect(mocks.requireReleaseFeatureEnabled).not.toHaveBeenCalled();
      expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();

      for (const page of [ManagerBriefingPage, VoiceSetupPage]) {
        const setupCtx = routeContext(role);
        mocks.getDashboardWriteClient.mockResolvedValueOnce(setupCtx);
        await expect(
          page({ params: Promise.resolve({ slug: "qa-salon" }) }),
        ).rejects.toThrow("REDIRECT:/dashboard/qa-salon/setup");
        expect(setupCtx.supabase.from).not.toHaveBeenCalled();
      }
      expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
    },
  );

  it.each(["anonymous visitor", "cross-tenant member"])(
    "redirects an $name before any privileged loader",
    async () => {
      mocks.getDashboardWriteClient.mockResolvedValue(null);

      await expect(
        SalonSettingsPage({
          params: Promise.resolve({ slug: "qa-salon" }),
          searchParams: Promise.resolve({}),
        }),
      ).rejects.toThrow("REDIRECT:/register");
      await expect(
        NailTryOnSetupPage({
          params: Promise.resolve({ slug: "qa-salon" }),
        }),
      ).rejects.toThrow("REDIRECT:/register");
      await expect(
        ManagerBriefingPage({
          params: Promise.resolve({ slug: "qa-salon" }),
        }),
      ).rejects.toThrow("REDIRECT:/register");
      await expect(
        VoiceSetupPage({
          params: Promise.resolve({ slug: "qa-salon" }),
        }),
      ).rejects.toThrow("REDIRECT:/register");

      expect(mocks.getSalonDomain).not.toHaveBeenCalled();
      expect(mocks.requireReleaseFeatureEnabled).not.toHaveBeenCalled();
      expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
    },
  );
});

function collectPageFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return collectPageFiles(path);
    return entry.name === "page.tsx" ? [path] : [];
  });
}

describe("dashboard route authorization inventory", () => {
  it("classifies every dashboard page and keeps every management route on a server boundary", () => {
    const root = resolve(process.cwd(), "src/app/dashboard/[slug]");
    const managementRoutes = [
      "activity/page.tsx",
      "ai/page.tsx",
      "approvals/page.tsx",
      "combos/page.tsx",
      "disputes/page.tsx",
      "import/page.tsx",
      "insights/page.tsx",
      "manager/page.tsx",
      "marketing/page.tsx",
      "no-show-protection/page.tsx",
      "pulse/page.tsx",
      "referrals/page.tsx",
      "reviews/page.tsx",
      "sessions/page.tsx",
      "settings/my-page/page.tsx",
      "settings/page.tsx",
      "settings/readiness/page.tsx",
      "settings/staff/page.tsx",
      "setup/address/page.tsx",
      "setup/ai-prefill/page.tsx",
      "setup/hours/page.tsx",
      "setup/loyalty/page.tsx",
      "setup/manager-briefing/page.tsx",
      "setup/nail-tryon/page.tsx",
      "setup/page.tsx",
      "setup/preview/page.tsx",
      "setup/promotions/page.tsx",
      "setup/services/page.tsx",
      "setup/staff/page.tsx",
      "setup/voice/page.tsx",
    ].sort();
    const nonManagementRoutes = [
      "center/page.tsx",
      "clients/page.tsx",
      "page.tsx",
      "photos/page.tsx",
      "qr-poster/page.tsx",
    ].sort();
    const discovered = collectPageFiles(root)
      .map((file) => relative(root, file))
      .sort();

    expect([...managementRoutes, ...nonManagementRoutes].sort()).toEqual(discovered);

    const serverBoundarySignals = [
      "isOwnerOrAdmin(ctx.role)",
      'ctx.role !== "owner"',
      'ctx.role === "owner"',
      '["owner", "admin", "manager"].includes(ctx.role)',
      "loadGoLiveReadiness(slug)",
      "loadGuidedBookingPreview(slug)",
      "loadPromotionsData(slug)",
      "redirect(`/dashboard/${slug}/setup/staff`)",
    ];

    for (const route of managementRoutes) {
      const source = readFileSync(join(root, route), "utf8");
      expect(
        serverBoundarySignals.some((signal) => source.includes(signal)),
        `${route} must reject lower roles in the route or an approved server loader`,
      ).toBe(true);
    }
  });
});

describe("settings service-action role matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServiceRoleClient.mockImplementation(serviceRoleClient);
  });

  it.each(["owner", "admin"] as const)(
    "allows a same-salon %s to load protected settings",
    async (role) => {
      mocks.resolveSalonForDashboard.mockResolvedValue(routeContext(role));

      await expect(loadTaxSettings("qa-salon")).resolves.toMatchObject({
        ok: true,
        taxLines: [],
      });
      await expect(loadGroupBookingSettings("qa-salon")).resolves.toEqual({
        ok: true,
        settings: { declineCutoffHours: 2 },
      });
      expect(mocks.createServiceRoleClient).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["senior", "receptionist", "nail_tech"] as const)(
    "rejects a %s before creating a service-role tax client",
    async (role) => {
      mocks.resolveSalonForDashboard.mockResolvedValue(routeContext(role));

      await expect(loadTaxSettings("qa-salon")).resolves.toEqual({
        ok: false,
        taxLines: [],
        preset: null,
        locationLabel: null,
      });
      await expect(loadGroupBookingSettings("qa-salon")).resolves.toEqual({
        ok: false,
      });
      expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
    },
  );

  it.each(["anonymous visitor", "cross-tenant member"])(
    "rejects an $name before creating a service-role tax client",
    async () => {
      mocks.resolveSalonForDashboard.mockResolvedValue(null);

      await expect(loadTaxSettings("qa-salon")).resolves.toMatchObject({
        ok: false,
        taxLines: [],
      });
      await expect(loadGroupBookingSettings("qa-salon")).resolves.toEqual({
        ok: false,
      });
      expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
    },
  );
});
