import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
  loadSalonOwnerDashboard: vi.fn(),
  loadOwnerHomeDashboard: vi.fn(),
  loadGoLiveReadiness: vi.fn(),
  isCocoSetupExperienceVisible: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/components/dashboard/SalonOwnerDashboard", () => ({
  SalonOwnerDashboard: function MockSalonOwnerDashboard() {
    return null;
  },
}));
vi.mock("@/components/dashboard/GuidedAdminActionCenter", () => ({
  GuidedAdminActionCenter: function MockGuidedAdminActionCenter() {
    return null;
  },
}));
vi.mock("@/shared/dashboard/salonOwnerActions", () => ({
  loadSalonOwnerDashboard: mocks.loadSalonOwnerDashboard,
  resolveSalonForDashboard: vi.fn(),
}));
vi.mock("@/shared/dashboard/loadOwnerHomeDashboardAction", () => ({
  loadOwnerHomeDashboard: mocks.loadOwnerHomeDashboard,
}));
vi.mock("@/shared/dashboard/loadGoLiveReadiness", () => ({
  loadGoLiveReadiness: mocks.loadGoLiveReadiness,
}));
vi.mock("@/shared/dashboard/guidedSetup", () => ({
  deriveGuidedSetupProgress: vi.fn(),
  resolveGuidedDashboardRoot: vi.fn(() => "dashboard"),
}));
vi.mock("@/shared/dashboard/cocoSetupActivation", () => ({
  isCocoSetupExperienceVisible: mocks.isCocoSetupExperienceVisible,
}));

import SalonDashboardPage from "./page";

describe("SalonDashboardPage redirect-loop guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadOwnerHomeDashboard.mockResolvedValue({
      ok: false,
      error: "server_error",
    });
    mocks.isCocoSetupExperienceVisible.mockResolvedValue(false);
  });

  it("renders the fail-closed retry state instead of redirecting an authorization miss to /register", async () => {
    const unauthorized = { ok: false, error: "unauthorized" } as const;
    mocks.loadSalonOwnerDashboard.mockResolvedValue(unauthorized);

    const result = await SalonDashboardPage({
      params: Promise.resolve({ slug: "hilite-studio" }),
    });

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(result.props).toMatchObject({
      slug: "hilite-studio",
      initialResult: unauthorized,
      homeData: null,
    });
  });

  it("keeps a client refresh authorization miss on the stable retry screen", async () => {
    const source = await readFile(
      new URL(
        "../../../components/dashboard/SalonOwnerDashboard.tsx",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).not.toContain('router.replace("/register")');
    expect(source).toContain("setData(null);");
    expect(source).toContain("setLoadError(true);");
  });
});
