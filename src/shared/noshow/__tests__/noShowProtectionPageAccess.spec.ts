import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
  getDashboardWriteClient: vi.fn(),
  isReleaseFeatureVisible: vi.fn(),
  loadNoShowDashboard: vi.fn(),
  loadNoShowFeeReviewQueue: vi.fn(),
  loadGroupCancellationFeeReviewQueue: vi.fn(),
  loadLateCancellationFeeReviewQueue: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));
vi.mock("@/shared/dashboard/setupActions", () => ({
  getDashboardWriteClient: mocks.getDashboardWriteClient,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock("@/shared/noshow/noShowDashboardActions", () => ({
  loadNoShowDashboard: mocks.loadNoShowDashboard,
}));
vi.mock("@/shared/noshow/noShowFeeApprovalActions", () => ({
  loadNoShowFeeReviewQueue: mocks.loadNoShowFeeReviewQueue,
}));
vi.mock("@/shared/noshow/groupCancellationFeeApprovalActions", () => ({
  loadGroupCancellationFeeReviewQueue:
    mocks.loadGroupCancellationFeeReviewQueue,
}));
vi.mock("@/shared/noshow/lateCancellationFeeApprovalActions", () => ({
  loadLateCancellationFeeReviewQueue:
    mocks.loadLateCancellationFeeReviewQueue,
}));
vi.mock("@/shared/features/platformFeatureFlags", () => ({
  isReleaseFeatureVisible: mocks.isReleaseFeatureVisible,
}));
vi.mock("@/components/dashboard/NoShowProtectionHub", () => ({
  NoShowProtectionHub: () => "LEGACY_NO_SHOW_HUB",
}));
vi.mock("@/components/dashboard/SquareSyncCard", () => ({
  SquareSyncCard: () => "LEGACY_SQUARE_SYNC",
}));
vi.mock("@/components/dashboard/GroupCancellationFeeApprovalQueue", () => ({
  GroupCancellationFeeApprovalQueue: () => "GROUP_CANCEL_FEE_QUEUE",
}));
vi.mock("@/components/dashboard/LateCancellationFeeApprovalQueue", () => ({
  LateCancellationFeeApprovalQueue: () => "LATE_CANCEL_FEE_QUEUE",
}));
vi.mock("@/components/dashboard/GuidedSetupReturnCard", () => ({
  GuidedSetupReturnCard: () => "GUIDED_SETUP_RETURN",
}));
vi.mock("@/components/dashboard/GuidedBookingPolicySetup", () => ({
  GuidedBookingPolicySetup: () => "GUIDED_POLICY_ONLY",
}));

import NoShowProtectionPage from "@/app/dashboard/[slug]/no-show-protection/page";

class EmptySingleQuery {
  constructor(private readonly data: unknown = null) {}
  select(): this { return this; }
  eq(): this { return this; }
  maybeSingle(): Promise<{ data: unknown; error: null }> {
    return Promise.resolve({ data: this.data, error: null });
  }
}

function routeContext(
  role: "owner" | "admin" | "senior" | "receptionist" | "nail_tech",
  policyData: unknown = null,
) {
  return {
    role,
    kind: "member",
    userId: "user-1",
    salon: { id: "salon-1", name: "QA Salon", slug: "qa-salon" },
    supabase: {
      from: vi.fn(() => new EmptySingleQuery(policyData)),
      rpc: vi.fn().mockResolvedValue({
        data: {
          success: true,
          code: "loaded",
          role,
          settings: policyData,
        },
        error: null,
      }),
    },
  };
}

describe("No-Show Protection page deep-link boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redirect.mockImplementation((href: string) => {
      throw new Error(`REDIRECT:${href}`);
    });
    mocks.createServiceRoleClient.mockReturnValue({
      from: vi.fn(() => new EmptySingleQuery()),
    });
    mocks.loadNoShowDashboard.mockResolvedValue({
      ok: true,
      summary: {},
      unconfirmed: [],
      waitlist: [],
      uncollectedFees: [],
    });
    mocks.loadNoShowFeeReviewQueue.mockResolvedValue([]);
    mocks.loadGroupCancellationFeeReviewQueue.mockResolvedValue([]);
    mocks.loadLateCancellationFeeReviewQueue.mockResolvedValue([]);
    mocks.isReleaseFeatureVisible.mockResolvedValue(false);
  });

  it.each(["owner", "admin"] as const)(
    "allows a same-salon %s to render the protected page",
    async (role) => {
      mocks.getDashboardWriteClient.mockResolvedValue(routeContext(role));

      await expect(
        NoShowProtectionPage({
          params: Promise.resolve({ slug: "qa-salon" }),
        }),
      ).resolves.toBeTruthy();
      expect(mocks.createServiceRoleClient).toHaveBeenCalledOnce();
      expect(mocks.loadNoShowDashboard).toHaveBeenCalledWith("qa-salon");
    },
  );

  it.each(["owner", "admin"] as const)(
    "renders policy-only setup for a Guided %s without loading legacy operations",
    async (role) => {
      mocks.isReleaseFeatureVisible.mockResolvedValue(true);
      mocks.getDashboardWriteClient.mockResolvedValue(
        routeContext(role, {
          name: "QA Salon",
          cancellation_policy: { en: "English policy", vi: "Chính sách" },
          feature_flags: {
            guided_admin_setup_enabled: true,
            group_booking_enabled: true,
          },
          group_together_threshold_minutes: 15,
          noshow_group_whole_party: true,
        }),
      );

      const page = await NoShowProtectionPage({
        params: Promise.resolve({ slug: "qa-salon" }),
      });
      const html = renderToStaticMarkup(page);

      expect(html).toContain("GUIDED_POLICY_ONLY");
      expect(html).toContain("GUIDED_SETUP_RETURN");
      expect(html).not.toContain("LEGACY_NO_SHOW_HUB");
      expect(html).not.toContain("LEGACY_SQUARE_SYNC");
      expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
      expect(mocks.loadNoShowDashboard).not.toHaveBeenCalled();
    },
  );

  it("preserves the legacy hub and sync card when Guided is effectively off", async () => {
    mocks.isReleaseFeatureVisible.mockResolvedValue(false);
    mocks.getDashboardWriteClient.mockResolvedValue(routeContext("owner"));

    const page = await NoShowProtectionPage({
      params: Promise.resolve({ slug: "qa-salon" }),
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("LEGACY_NO_SHOW_HUB");
    expect(html).toContain("LEGACY_SQUARE_SYNC");
    expect(html).not.toContain("GUIDED_POLICY_ONLY");
    expect(mocks.createServiceRoleClient).toHaveBeenCalledOnce();
    expect(mocks.loadNoShowDashboard).toHaveBeenCalledWith("qa-salon");
  });

  it.each(["senior", "receptionist", "nail_tech"] as const)(
    "redirects a %s before creating a service-role client",
    async (role) => {
      mocks.getDashboardWriteClient.mockResolvedValue(routeContext(role));

      await expect(
        NoShowProtectionPage({
          params: Promise.resolve({ slug: "qa-salon" }),
        }),
      ).rejects.toThrow("REDIRECT:/dashboard/qa-salon");
      expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
      expect(mocks.loadNoShowDashboard).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "foreign member" },
    { name: "anonymous visitor" },
  ])(
    "redirects a $name before creating a service-role client",
    async () => {
      mocks.getDashboardWriteClient.mockResolvedValue(null);

      await expect(
        NoShowProtectionPage({
          params: Promise.resolve({ slug: "qa-salon" }),
        }),
      ).rejects.toThrow("REDIRECT:/register");
      expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
      expect(mocks.loadNoShowDashboard).not.toHaveBeenCalled();
    },
  );
});
