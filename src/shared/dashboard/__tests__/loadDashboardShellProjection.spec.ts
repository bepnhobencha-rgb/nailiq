import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));

import { loadDashboardShellProjection } from "../loadDashboardShellProjection";

const row = {
  setup_wizard_completed_at: "2026-08-25T00:00:00.000Z",
  stripe_subscription_id: null,
  subscription_status: "trialing",
  trial_ends_at: "2026-09-01T00:00:00.000Z",
  waiting_count: 2,
  waitlist_count: 3,
  overdue_count: 1,
  pending_approvals_count: 4,
};

describe("dashboard shell projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps the bounded service projection", async () => {
    mocks.rpc.mockResolvedValue({ data: row, error: null });

    await expect(
      loadDashboardShellProjection("salon-1", "2026-08-25T07:00:00.000Z"),
    ).resolves.toEqual({
      setupWizardCompletedAt: row.setup_wizard_completed_at,
      stripeSubscriptionId: null,
      subscriptionStatus: "trialing",
      trialEndsAt: row.trial_ends_at,
      waitingCount: 2,
      waitlistCount: 3,
      overdueCount: 1,
      pendingApprovalsCount: 4,
    });
  });

  it("coalesces concurrent reads and removes the settled flight", async () => {
    let release!: (value: { data: typeof row; error: null }) => void;
    mocks.rpc.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const first = loadDashboardShellProjection(
      "salon-2",
      "2026-08-25T07:00:00.000Z",
    );
    const second = loadDashboardShellProjection(
      "salon-2",
      "2026-08-25T07:00:00.000Z",
    );
    release({ data: row, error: null });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(mocks.rpc).toHaveBeenCalledOnce();

    mocks.rpc.mockResolvedValueOnce({ data: row, error: null });
    await loadDashboardShellProjection("salon-2", "2026-08-25T07:00:00.000Z");
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("fails closed to the caller fallback on malformed data", async () => {
    mocks.rpc.mockResolvedValue({
      data: { ...row, pending_approvals_count: -1 },
      error: null,
    });

    await expect(
      loadDashboardShellProjection("salon-3", "2026-08-25T07:00:00.000Z"),
    ).resolves.toBeNull();
  });
});
