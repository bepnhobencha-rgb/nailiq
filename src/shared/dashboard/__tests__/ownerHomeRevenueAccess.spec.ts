import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSalonForDashboard: vi.fn(),
  createServiceRoleClient: vi.fn(),
  loadUnclosedBookings: vi.fn(),
  getPendingApprovals: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/dashboard/salonOwnerActions", () => ({
  resolveSalonForDashboard: mocks.resolveSalonForDashboard,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock("@/shared/dashboard/loadUnclosedBookings", () => ({
  loadUnclosedBookings: mocks.loadUnclosedBookings,
}));
vi.mock("@/shared/ai/approvalRequests", () => ({
  getPendingApprovals: mocks.getPendingApprovals,
}));

import { loadOwnerHomeDashboard } from "@/shared/dashboard/loadOwnerHomeDashboardAction";

type Role = "owner" | "admin" | "senior" | "receptionist" | "nail_tech";

function resolved(role: Role) {
  return {
    kind: "member",
    role,
    viewerEmail: "viewer@example.test",
    viewerUserId: "21111111-1111-4111-8111-111111111111",
    salon: {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "qa-salon",
    },
  };
}

describe("owner-home revenue authorization boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["senior", "receptionist", "nail_tech"] as const)(
    "rejects a %s before any service-role revenue read",
    async (role) => {
      mocks.resolveSalonForDashboard.mockResolvedValue(resolved(role));

      await expect(loadOwnerHomeDashboard("qa-salon")).resolves.toEqual({
        ok: false,
        error: "forbidden",
      });
      expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
      expect(mocks.getPendingApprovals).not.toHaveBeenCalled();
      expect(mocks.loadUnclosedBookings).not.toHaveBeenCalled();
    },
  );

  it("rejects an anonymous or cross-tenant slug before any privileged read", async () => {
    mocks.resolveSalonForDashboard.mockResolvedValue(null);

    await expect(loadOwnerHomeDashboard("foreign-salon")).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
    expect(mocks.getPendingApprovals).not.toHaveBeenCalled();
    expect(mocks.loadUnclosedBookings).not.toHaveBeenCalled();
  });
});
