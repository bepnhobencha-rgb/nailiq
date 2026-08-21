import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), from: vi.fn() }));
vi.mock("@/shared/booking/bookingManagementCapabilities", () => ({
  inspectBookingManagementCapability: mocks.inspect,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ from: mocks.from }),
}));

import { loadRsvpPageData } from "../groupMemberRsvpActions";

const context = {
  bookingId: "11111111-1111-4111-8111-111111111111",
  salonId: "22222222-2222-4222-8222-222222222222",
  serviceId: "33333333-3333-4333-8333-333333333333",
  staffId: null,
  durationMinutes: 60,
  timezone: "America/Los_Angeles",
  currentStartTimeUtc: "2099-08-20T17:00:00.000Z",
  currentEndTimeUtc: "2099-08-20T18:00:00.000Z",
  groupId: "44444444-4444-4444-8444-444444444444",
  isGroupOrganizer: false,
};
const booking = {
  status: "pending",
  startTimeUtc: context.currentStartTimeUtc,
  endTimeUtc: context.currentEndTimeUtc,
  serviceName: "Manicure",
  staffName: "Anna",
  salonSlug: "qa-salon",
  salonName: "QA Salon",
  salonTimezone: context.timezone,
};

function inspection(action: "confirm" | "cancel", scopeKind = "member_own") {
  return { ok: true, inspection: { action, scopeKind, context, booking } };
}

describe("group member RSVP capability scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => ({
        data: {
          id: context.bookingId, client_name: "Mai", group_id: null,
          status: "confirmed", attendance_status: "pending",
        },
        error: null,
      })),
    };
    mocks.from.mockReturnValue(builder);
  });

  it("requires independent confirm and cancel capabilities for the same member-own booking", async () => {
    mocks.inspect.mockResolvedValueOnce(inspection("confirm")).mockResolvedValueOnce(inspection("cancel"));
    const result = await loadRsvpPageData("confirm-capability", "cancel-capability");
    expect(result).toMatchObject({
      ok: true,
      bookingId: context.bookingId,
      scopeKind: "member_own",
      currentStatus: "pending",
    });
    expect(mocks.inspect).toHaveBeenNthCalledWith(1, {
      tokenId: "confirm-capability", expectedAction: "confirm",
    });
    expect(mocks.inspect).toHaveBeenNthCalledWith(2, {
      tokenId: "cancel-capability", expectedAction: "cancel",
    });
  });

  it("does not mistake a canonical confirmed group booking for an explicit member RSVP", async () => {
    mocks.inspect.mockResolvedValueOnce(inspection("confirm")).mockResolvedValueOnce(inspection("cancel"));
    await expect(loadRsvpPageData("confirm-capability", "cancel-capability")).resolves.toMatchObject({
      ok: true,
      currentStatus: "pending",
    });
  });

  it("fails before booking lookup when either bearer has whole-party or mismatched scope", async () => {
    mocks.inspect.mockResolvedValueOnce(inspection("confirm", "member_own"))
      .mockResolvedValueOnce(inspection("cancel", "organizer_whole_party"));
    await expect(loadRsvpPageData("confirm-capability", "cancel-capability")).resolves.toEqual({
      ok: false, code: "member_scope_mismatch",
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("keeps organizer-own scoped to the organizer's own spot", async () => {
    mocks.inspect.mockResolvedValueOnce(inspection("confirm", "organizer_own"))
      .mockResolvedValueOnce(inspection("cancel", "organizer_own"));
    await expect(loadRsvpPageData("confirm-capability", "cancel-capability")).resolves.toMatchObject({
      ok: true,
      scopeKind: "organizer_own",
      currentStatus: "pending",
    });
  });
});
