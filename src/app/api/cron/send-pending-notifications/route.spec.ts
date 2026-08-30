import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  retryWorker: vi.fn(),
  staffActionWorker: vi.fn(),
  ownerBookingWorker: vi.fn(),
  ownerWaitlistWorker: vi.fn(),
  platform: vi.fn(),
  transitionWorker: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/security/cronAuthorization", () => ({
  requireCronAuthorization: () => null,
}));
vi.mock("@/shared/security/cronRunHistory", () => ({
  runTrackedCron: (_worker: string, handler: () => Promise<Response>) => handler(),
}));
vi.mock("@/shared/booking/bookingConfirmationRetryDelivery", () => ({
  runBookingConfirmationRetryWorker: mocks.retryWorker,
}));
vi.mock("@/shared/notifications/staffActionNotificationWorker", () => ({
  runStaffActionNotificationWorker: mocks.staffActionWorker,
}));
vi.mock("@/shared/notifications/ownerBookingNotificationWorker", () => ({
  runOwnerBookingNotificationWorker: mocks.ownerBookingWorker,
}));
vi.mock("@/shared/notifications/ownerWaitlistNotificationWorker", () => ({
  runOwnerWaitlistNotificationWorker: mocks.ownerWaitlistWorker,
}));
vi.mock("@/shared/superadmin/platformAnnouncementEmail", () => ({
  deliverPendingPlatformAnnouncementEmails: mocks.platform,
}));
vi.mock("@/shared/notifications/customerBookingTransitionEmail", () => ({
  runCustomerBookingTransitionEmailWorker: mocks.transitionWorker,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => {
    const due = Array.from({ length: 100 }, (_, index) => ({
      id: `scheduled-${index}`,
      salon_id: "11111111-1111-4111-8111-111111111111",
      booking_id: "22222222-2222-4222-8222-222222222222",
      event: "create",
      channels: { email: true },
    }));
    return {
      from: () => {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          lte: () => chain,
          order: () => chain,
          limit: async () => ({ data: due, error: null }),
        };
        return chain;
      },
    };
  },
}));

import { GET } from "@/app/api/cron/send-pending-notifications/route";

describe("send-pending-notifications booking confirmation retry priority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    mocks.retryWorker.mockImplementation(async () => {
      mocks.order.push("confirmation-retries");
      return { retriesProcessed: 0 };
    });
    mocks.staffActionWorker.mockImplementation(async () => {
      mocks.order.push("staff-action-worker");
      return { ok: true, claimed: 0 };
    });
    mocks.ownerBookingWorker.mockImplementation(async () => {
      mocks.order.push("owner-booking-worker");
      return { ok: true, claimed: 0 };
    });
    mocks.ownerWaitlistWorker.mockImplementation(async () => {
      mocks.order.push("owner-waitlist-worker");
      return { ok: true, claimed: 0 };
    });
    mocks.platform.mockResolvedValue({ sent: 0 });
    mocks.transitionWorker.mockResolvedValue({ retriesProcessed: 0 });
  });

  it("drains the immutable staff-action worker and never dispatches the mutable legacy backlog", async () => {
    const response = await GET(new NextRequest("https://nailiq.test/api/cron/send-pending-notifications"));
    expect(response.status).toBe(200);
    expect(mocks.retryWorker).toHaveBeenCalledWith(10);
    expect(mocks.staffActionWorker).toHaveBeenCalledWith(10);
    expect(mocks.ownerBookingWorker).toHaveBeenCalledWith(10);
    expect(mocks.ownerWaitlistWorker).toHaveBeenCalledWith(10);
    expect(mocks.order[0]).toBe("staff-action-worker");
    expect(mocks.order[1]).toBe("owner-booking-worker");
    expect(mocks.order[2]).toBe("owner-waitlist-worker");
    expect(mocks.order[3]).toBe("confirmation-retries");
    expect(await response.json()).toMatchObject({
      claimed: 0,
      legacyStaffActionPending: 100,
    });
  });
});
