import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getContext: vi.fn(),
  visible: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  redirect: vi.fn((href: string) => {
    throw new Error(`REDIRECT:${href}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/shared/dashboard/setupActions", () => ({
  getDashboardWriteClient: mocks.getContext,
}));
vi.mock("@/shared/dashboard/cocoSetupActivation", () => ({
  isCocoSetupExperienceVisible: mocks.visible,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    from: () => ({ update: mocks.update }),
  }),
}));

import { skipGuidedSetupIntegrations } from "@/shared/dashboard/skipGuidedSetupIntegrationsAction";

describe("skipGuidedSetupIntegrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getContext.mockResolvedValue({
      role: "owner",
      salon: { id: "salon-id", feature_flags: {} },
    });
    mocks.visible.mockResolvedValue(true);
    mocks.update.mockReturnValue({ eq: mocks.eq });
    mocks.eq.mockResolvedValue({ error: null });
  });

  it("persists the optional decision for the authorized exact tenant then advances", async () => {
    await expect(skipGuidedSetupIntegrations("qa salon")).rejects.toThrow(
      "REDIRECT:/dashboard/qa%20salon/setup/preview",
    );
    expect(mocks.update).toHaveBeenCalledWith({
      guided_setup_integrations_skipped_at:
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(mocks.eq).toHaveBeenCalledWith("id", "salon-id");
  });

  it("fails before service-role write for non-management and flag-off callers", async () => {
    mocks.getContext.mockResolvedValueOnce({
      role: "receptionist",
      salon: { id: "salon-id", feature_flags: {} },
    });
    await expect(skipGuidedSetupIntegrations("qa-salon")).rejects.toThrow(
      "REDIRECT:/register",
    );
    expect(mocks.update).not.toHaveBeenCalled();

    mocks.getContext.mockResolvedValueOnce({
      role: "owner",
      salon: { id: "salon-id", feature_flags: {} },
    });
    mocks.visible.mockResolvedValueOnce(false);
    await expect(skipGuidedSetupIntegrations("qa-salon")).rejects.toThrow(
      "REDIRECT:/dashboard/qa-salon",
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not advance when persistence fails", async () => {
    mocks.eq.mockResolvedValueOnce({ error: { code: "PGRST500" } });
    await expect(skipGuidedSetupIntegrations("qa-salon")).rejects.toThrow(
      "REDIRECT:/dashboard/qa-salon/setup?skip=failed",
    );
    expect(mocks.redirect).not.toHaveBeenCalledWith(
      "/dashboard/qa-salon/setup/preview",
    );
  });
});
