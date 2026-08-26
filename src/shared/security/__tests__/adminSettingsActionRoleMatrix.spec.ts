import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getDashboardWriteClient: vi.fn(),
  trackAnthropicFetch: vi.fn(),
}));

vi.mock("@/shared/dashboard/setupActions", () => ({
  getDashboardWriteClient: mocks.getDashboardWriteClient,
}));
vi.mock("@/shared/ai/usageLedger", () => ({
  trackAnthropicFetch: mocks.trackAnthropicFetch,
}));

import { extractBrandFromImageUrl } from "@/shared/dashboard/extractBrandFromWebsiteAction";
import {
  deleteStaffShift,
  deleteStaffUnavailability,
  listActiveStaff,
  listStaffShifts,
  listStaffUnavailability,
  upsertStaffShift,
  upsertStaffUnavailability,
} from "@/shared/dashboard/staffShiftActions";
import { getStaffNotificationSettings } from "@/shared/dashboard/staffNotificationActions";
import { getOwnerNotificationSettings } from "@/shared/dashboard/ownerNotificationActions";
import { getCustomerChannelSettings } from "@/shared/dashboard/customerChannelActions";

type SalonRole = "owner" | "admin" | "senior" | "receptionist" | "nail_tech";

class EmptyQuery {
  select(): this { return this; }
  delete(): this { return this; }
  eq(): this { return this; }
  gte(): this { return this; }
  lte(): this { return this; }
  order(): this { return this; }
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

function context(role: SalonRole) {
  return {
    role,
    kind: "member" as const,
    userId: "user-1",
    salon: { id: "salon-1", name: "QA Salon", slug: "qa-salon" },
    supabase: {
      from: vi.fn(() => new EmptyQuery()),
      rpc: vi.fn().mockResolvedValue({
        data: {
          success: true,
          code: "loaded",
          role,
          settings: {},
        },
        error: null,
      }),
    },
  };
}

async function callEveryManagementAction() {
  return Promise.all([
    listActiveStaff("qa-salon"),
    listStaffShifts("qa-salon"),
    listStaffUnavailability("qa-salon", "2026-08-20", "2026-09-20"),
    upsertStaffShift(
      "qa-salon",
      "staff-1",
      "invalid-day",
      "09:00",
      "17:00",
    ),
    deleteStaffShift("qa-salon", "shift-1"),
    upsertStaffUnavailability(
      "qa-salon",
      "staff-1",
      "invalid-date",
    ),
    deleteStaffUnavailability("qa-salon", "unavailability-1"),
    extractBrandFromImageUrl("qa-salon", "not a valid url"),
  ]);
}

describe("management settings Server Action role matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["owner", "admin"] as const)(
    "allows a same-salon %s past authorization without calling a provider",
    async (role) => {
      const ctx = context(role);
      mocks.getDashboardWriteClient.mockResolvedValue(ctx);

      const results = await callEveryManagementAction();

      expect(results.slice(0, 3)).toEqual([
        { ok: true, data: [] },
        { ok: true, data: [] },
        { ok: true, data: [] },
      ]);
      expect(results[3]).toEqual({ ok: false, error: "invalid_day" });
      expect(results[4]).toEqual({ ok: true });
      expect(results[5]).toEqual({ ok: false, error: "invalid_date_format" });
      expect(results[6]).toEqual({ ok: true });
      expect(results[7]).toEqual({ ok: false, error: "invalid_url" });
      expect(ctx.supabase.from).toHaveBeenCalledTimes(5);
      expect(mocks.trackAnthropicFetch).not.toHaveBeenCalled();
    },
  );

  it.each(["senior", "receptionist", "nail_tech"] as const)(
    "rejects a %s before any DB or provider work",
    async (role) => {
      const ctx = context(role);
      mocks.getDashboardWriteClient.mockResolvedValue(ctx);

      const results = await callEveryManagementAction();

      for (const result of results) {
        expect(result).toEqual({ ok: false, error: "forbidden" });
      }
      expect(ctx.supabase.from).not.toHaveBeenCalled();
      expect(mocks.trackAnthropicFetch).not.toHaveBeenCalled();
    },
  );

  it.each(["anonymous visitor", "cross-tenant member"])(
    "rejects an $name before any DB or provider work",
    async () => {
      mocks.getDashboardWriteClient.mockResolvedValue(null);

      const results = await callEveryManagementAction();

      for (const result of results) {
        expect(result).toEqual({ ok: false, error: "unauthorized" });
      }
      expect(mocks.trackAnthropicFetch).not.toHaveBeenCalled();
    },
  );
});

describe("management settings read RPC role matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["owner", "admin"] as const)(
    "allows a same-salon %s through the curated settings RPC",
    async (role) => {
      const ctx = context(role);
      mocks.getDashboardWriteClient.mockResolvedValue(ctx);

      const results = await Promise.all([
        getStaffNotificationSettings("qa-salon"),
        getOwnerNotificationSettings("qa-salon"),
        getCustomerChannelSettings("qa-salon"),
      ]);

      for (const result of results) expect(result.ok).toBe(true);
      expect(ctx.supabase.rpc).toHaveBeenCalledTimes(3);
      expect(ctx.supabase.from).not.toHaveBeenCalled();
    },
  );

  it.each(["senior", "receptionist", "nail_tech"] as const)(
    "rejects a %s before the curated settings RPC",
    async (role) => {
      const ctx = context(role);
      mocks.getDashboardWriteClient.mockResolvedValue(ctx);

      await expect(getStaffNotificationSettings("qa-salon")).resolves.toEqual({
        ok: false,
        error: "forbidden",
      });
      await expect(getOwnerNotificationSettings("qa-salon")).resolves.toEqual({
        ok: false,
        error: "forbidden",
      });
      await expect(getCustomerChannelSettings("qa-salon")).resolves.toEqual({
        ok: false,
      });
      expect(ctx.supabase.rpc).not.toHaveBeenCalled();
      expect(ctx.supabase.from).not.toHaveBeenCalled();
    },
  );

  it.each(["anonymous visitor", "cross-tenant member"])(
    "rejects an $name before any settings loader",
    async () => {
      mocks.getDashboardWriteClient.mockResolvedValue(null);

      await expect(getStaffNotificationSettings("qa-salon")).resolves.toEqual({
        ok: false,
        error: "unauthorized",
      });
      await expect(getOwnerNotificationSettings("qa-salon")).resolves.toEqual({
        ok: false,
        error: "unauthorized",
      });
      await expect(getCustomerChannelSettings("qa-salon")).resolves.toEqual({
        ok: false,
      });
    },
  );
});
