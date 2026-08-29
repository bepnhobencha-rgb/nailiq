import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attributeRecentAudit: vi.fn(),
  chargeNoShowFeeOperational: vi.fn(),
  createServiceRoleClient: vi.fn(),
  getDashboardWriteClient: vi.fn(),
  sendNoShowFeeLinkOperational: vi.fn(),
  waiveNoShowFeeOperational: vi.fn(),
}));

vi.mock("@/shared/dashboard/setupActions", () => ({
  getDashboardWriteClient: mocks.getDashboardWriteClient,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock("@/shared/dashboard/attributeAudit", () => ({
  attributeRecentAudit: mocks.attributeRecentAudit,
}));
vi.mock("@/shared/dashboard/receptionistActions", () => ({
  chargeNoShowFeeManual: mocks.chargeNoShowFeeOperational,
  sendNoShowFeeLink: mocks.sendNoShowFeeLinkOperational,
  waiveNoShowFee: mocks.waiveNoShowFeeOperational,
}));

import {
  chargeNoShowFeeFromProtection,
  loadNoShowDashboard,
  loadNoShowHistory,
  sendNoShowFeeLinkFromProtection,
  updateNoShowCardSettings,
  updateReminderSettings,
  updateRemindersEnabled,
  updateSquareSyncSettings,
  updateWaitlistAutoBook,
  waiveBookingDeposit,
  waiveNoShowFeeFromProtection,
} from "../noShowDashboardActions";

class EmptyQuery {
  select(): this { return this; }
  update(): this { return this; }
  eq(): this { return this; }
  neq(): this { return this; }
  not(): this { return this; }
  in(): this { return this; }
  gte(): this { return this; }
  lte(): this { return this; }
  order(): this { return this; }
  limit(): this { return this; }
  range(): Promise<{ data: unknown[]; count: number; error: null }> {
    return Promise.resolve({ data: [], count: 0, error: null });
  }
  maybeSingle(): Promise<{ data: null; error: null }> {
    return Promise.resolve({ data: null, error: null });
  }
  then<TResult1 = { data: unknown[]; count: number; error: null }, TResult2 = never>(
    onFulfilled?:
      | ((value: { data: unknown[]; count: number; error: null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve({ data: [], count: 0, error: null }).then(
      onFulfilled,
      onRejected,
    );
  }
}

function emptyServiceClient() {
  return { from: vi.fn(() => new EmptyQuery()) };
}

function managerContext(role: "owner" | "admin" | "senior" | "receptionist" | "nail_tech") {
  return {
    role,
    kind: "member",
    userId: "user-1",
    salon: { id: "salon-1", name: "QA Salon", slug: "qa-salon" },
    supabase: emptyServiceClient(),
  };
}

async function callEveryStepFiveEntry() {
  const slug = "qa-salon";
  const salonId = "salon-1";
  const bookingId = "00000000-0000-4000-8000-000000000001";
  return Promise.all([
    loadNoShowDashboard(slug),
    loadNoShowHistory(slug),
    updateRemindersEnabled(slug, true),
    updateWaitlistAutoBook(slug, true),
    updateReminderSettings(slug, {}),
    updateSquareSyncSettings(slug, {}),
    updateNoShowCardSettings(slug, {}),
    waiveBookingDeposit(slug, bookingId),
    chargeNoShowFeeFromProtection(slug, { salonId, bookingId }),
    waiveNoShowFeeFromProtection(slug, { salonId, bookingId }),
    sendNoShowFeeLinkFromProtection(slug, { salonId, bookingId }),
  ]);
}

describe("No-Show Protection owner/admin boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServiceRoleClient.mockImplementation(emptyServiceClient);
    mocks.attributeRecentAudit.mockResolvedValue(undefined);
    mocks.chargeNoShowFeeOperational.mockResolvedValue({
      ok: true,
      charged: false,
      reason: "test_only",
    });
    mocks.waiveNoShowFeeOperational.mockResolvedValue({ ok: true });
    mocks.sendNoShowFeeLinkOperational.mockResolvedValue({
      ok: true,
      url: "https://example.invalid/test-only",
      amountCents: 0,
    });
  });

  it.each(["owner", "admin"] as const)(
    "allows a same-salon %s to load Step 5 and reach its protected wrappers",
    async (role) => {
      mocks.getDashboardWriteClient.mockResolvedValue(managerContext(role));

      await expect(loadNoShowDashboard("qa-salon")).resolves.toMatchObject({
        ok: true,
        summary: { highRiskCount: 0, cardsOnFileCount: 0 },
        unconfirmed: [],
        waitlist: [],
        uncollectedFees: [],
      });
      await expect(loadNoShowHistory("qa-salon")).resolves.toMatchObject({
        ok: true,
        items: [],
        hasMore: false,
      });
      await expect(
        chargeNoShowFeeFromProtection("qa-salon", {
          salonId: "salon-1",
          bookingId: "00000000-0000-4000-8000-000000000001",
        }),
      ).resolves.toMatchObject({ ok: true });

      expect(mocks.createServiceRoleClient).toHaveBeenCalled();
      expect(mocks.chargeNoShowFeeOperational).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { name: "senior", context: managerContext("senior") },
    { name: "receptionist", context: managerContext("receptionist") },
    { name: "nail_tech", context: managerContext("nail_tech") },
    { name: "foreign member", context: null },
    { name: "anonymous visitor", context: null },
  ])("rejects a $name before privileged reads or operations", async ({ context }) => {
    mocks.getDashboardWriteClient.mockResolvedValue(context);

    const results = await callEveryStepFiveEntry();
    expect(results).toHaveLength(11);
    for (const result of results) {
      expect(result).toEqual({ ok: false, error: "unauthorized" });
    }
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
    expect(mocks.chargeNoShowFeeOperational).not.toHaveBeenCalled();
    expect(mocks.waiveNoShowFeeOperational).not.toHaveBeenCalled();
    expect(mocks.sendNoShowFeeLinkOperational).not.toHaveBeenCalled();
    expect(mocks.attributeRecentAudit).not.toHaveBeenCalled();
  });

  it("keeps legacy fee history visible without exposing V1 money actions", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/dashboard/NoShowProtectionHub.tsx"),
      "utf8",
    );

    expect(source).not.toContain("@/shared/dashboard/receptionistActions");
    expect(source).not.toContain("chargeNoShowFeeFromProtection");
    expect(source).not.toContain("waiveNoShowFeeFromProtection");
    expect(source).not.toContain("sendNoShowFeeLinkFromProtection");
    expect(source).toContain("NailIQ V1 does not charge, retry, or send payment links");
  });
});
