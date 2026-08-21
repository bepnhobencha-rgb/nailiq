import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSalonForDashboard: vi.fn(),
  isReleaseFeatureVisible: vi.fn(),
  createServiceRoleClient: vi.fn(),
  salonToday: vi.fn(),
  salonDayRangeUtc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/dashboard/salonOwnerActions", () => ({
  resolveSalonForDashboard: mocks.resolveSalonForDashboard,
}));
vi.mock("@/shared/features/platformFeatureFlags", () => ({
  isReleaseFeatureVisible: mocks.isReleaseFeatureVisible,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock("@/shared/lib/salonTime", () => ({
  salonToday: mocks.salonToday,
  salonDayRangeUtc: mocks.salonDayRangeUtc,
}));

import { loadSalonReports } from "@/shared/dashboard/loadSalonReports";

type Role = "owner" | "admin" | "senior" | "receptionist" | "nail_tech";

function authorized(role: Role, salonId = "salon-1") {
  return {
    kind: "member",
    role,
    viewerEmail: "owner@example.test",
    viewerUserId: "user-1",
    salon: {
      id: salonId,
      slug: "qa-salon",
      feature_flags: { reports_enabled: true },
    },
  };
}

class ReportsQuery {
  constructor(
    private readonly result: { data: unknown; error: unknown },
  ) {}

  select(): this {
    return this;
  }

  eq(): this {
    return this;
  }

  gte(): this {
    return this;
  }

  lt(): Promise<{ data: unknown; error: unknown }> {
    return Promise.resolve(this.result);
  }

  maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    return Promise.resolve(this.result);
  }

  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

function setEmptyReportData() {
  const from = vi.fn((table: string) => {
    if (table === "salons") {
      return new ReportsQuery({
        data: { timezone: "America/Vancouver" },
        error: null,
      });
    }
    return new ReportsQuery({ data: [], error: null });
  });
  mocks.createServiceRoleClient.mockReturnValue({ from });
  return from;
}

describe("loadSalonReports access and effective rollout gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSalonForDashboard.mockResolvedValue(authorized("owner"));
    mocks.isReleaseFeatureVisible.mockResolvedValue(true);
    mocks.salonToday.mockReturnValue("2026-08-20");
    mocks.salonDayRangeUtc.mockReturnValue({
      startUtc: "2026-08-20T07:00:00.000Z",
      endUtc: "2026-08-21T07:00:00.000Z",
    });
    setEmptyReportData();
  });

  it.each(["owner", "admin"] as const)(
    "allows a same-tenant %s when the effective flag is ON",
    async (role) => {
      mocks.resolveSalonForDashboard.mockResolvedValue(authorized(role));

      await expect(loadSalonReports("qa-salon", "today")).resolves.toMatchObject({
        ok: true,
        data: { appointmentCount: 0, totalRevenueCents: 0 },
      });
      expect(mocks.isReleaseFeatureVisible).toHaveBeenCalledWith(
        expect.objectContaining({ id: "salon-1" }),
        "advanced_reports",
      );
      expect(mocks.createServiceRoleClient).toHaveBeenCalledOnce();
    },
  );

  it.each(["senior", "receptionist", "nail_tech"] as const)(
    "rejects a lower-role %s before feature or service-role data access",
    async (role) => {
      mocks.resolveSalonForDashboard.mockResolvedValue(authorized(role));

      await expect(loadSalonReports("qa-salon", "today")).resolves.toEqual({
        ok: false,
        error: "forbidden",
      });
      expect(mocks.isReleaseFeatureVisible).not.toHaveBeenCalled();
      expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
    },
  );

  it("rejects an anonymous or cross-tenant slug before service-role data access", async () => {
    mocks.resolveSalonForDashboard.mockResolvedValue(null);

    await expect(loadSalonReports("foreign-salon", "today")).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(mocks.isReleaseFeatureVisible).not.toHaveBeenCalled();
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("blocks effective OFF before service-role data access", async () => {
    mocks.isReleaseFeatureVisible.mockResolvedValue(false);

    await expect(loadSalonReports("qa-salon", "today")).resolves.toEqual({
      ok: false,
      error: "feature_not_enabled",
    });
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });
});
