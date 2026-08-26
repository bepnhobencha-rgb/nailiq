import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  quote: vi.fn(),
  replay: vi.fn(),
  apply: vi.fn(),
  transitionEmail: vi.fn(),
  ownerNotification: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/shared/booking/bookingSequenceReschedule", () => ({
  quoteBookingSequenceRescheduleForDesk: mocks.quote,
  replayBookingSequenceRescheduleForDesk: mocks.replay,
  rescheduleBookingSequenceForDesk: mocks.apply,
}));
vi.mock("@/shared/notifications/customerBookingTransitionEmail", () => ({
  deliverCustomerBookingTransitionEmail: mocks.transitionEmail,
}));
vi.mock("@/shared/dashboard/sendOwnerBookingNotification", () => ({
  sendOwnerBookingNotification: mocks.ownerNotification,
}));
vi.mock("@/shared/noshow/deliverPromotedWaitlistOffer", () => ({
  deliverPromotedWaitlistOffer: vi.fn(),
}));
vi.mock("@/shared/dashboard/dashboardBookingMap", () => ({
  DASHBOARD_BOOKING_SELECT: "id",
  mapDashboardBookingRow: (row: unknown) => row,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => serviceRoleClient(),
}));

import { performEditBooking } from "@/shared/dashboard/editBookingCore";

const salonId = "11111111-1111-4111-8111-111111111111";
const bookingId = "22222222-2222-4222-8222-222222222222";
const staffId = "33333333-3333-4333-8333-333333333333";
const serviceId = "44444444-4444-4444-8444-444444444444";
const actorUserId = "55555555-5555-4555-8555-555555555555";
const requestId = "66666666-6666-4666-8666-666666666666";
const startUtc = "2026-08-28T18:00:00.000Z";
const fingerprint = "a".repeat(64);

function fluent(result: () => Promise<unknown>) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(result);
  return builder;
}

function authorizedClient(bookingOverrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn((table: string) => fluent(async () => table === "staff"
      ? { data: { id: staffId }, error: null }
      : {
          data: {
            id: bookingId,
            salon_id: salonId,
            status: "confirmed",
            staff_id: staffId,
            service_id: serviceId,
            resource_id: null,
            addon_service_id: null,
            start_time_utc: "2026-08-27T18:00:00.000Z",
            end_time_utc: "2026-08-27T19:00:00.000Z",
            schedule_model: "segments_v1",
            ...bookingOverrides,
          },
          error: null,
        })),
  };
}

function serviceRoleClient() {
  return {
    from: vi.fn((table: string) => {
      if (table === "bookings") return fluent(async () => ({ data: { id: bookingId }, error: null }));
      return {
        insert: mocks.insert,
      };
    }),
  };
}

const quote = {
  requestId,
  bookingId,
  salonId,
  requestedStartTimeUtc: startUtc,
  sequenceFingerprint: fingerprint,
  segments: [],
};

const committed = {
  bookingId,
  salonId,
  previousStartTimeUtc: "2026-08-27T18:00:00.000Z",
  startTimeUtc: startUtc,
  endTimeUtc: "2026-08-28T19:00:00.000Z",
  transitionVersion: 2,
  sequenceFingerprint: fingerprint,
  receipt: { segments: [] },
  cancelPreview: { policyLockedByReschedule: false },
  promotedWaitlist: null,
  idempotent: false,
  customerTransitionSmsRequested: false,
};

function input(extra: Record<string, unknown> = {}) {
  return {
    salonId,
    bookingId,
    newStartTimeUtc: startUtc,
    newStaffId: staffId,
    newServiceId: serviceId,
    newAddonServiceId: null,
    sequenceRequestId: requestId,
    ...extra,
  };
}

describe("desk full-sequence reschedule core", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.after.mockImplementation(() => undefined);
    mocks.quote.mockResolvedValue({ ok: true, quote });
    mocks.replay.mockResolvedValue({ ok: false, code: "replay_not_found" });
    mocks.apply.mockResolvedValue({ ok: true, result: committed });
    mocks.insert.mockResolvedValue({ data: null, error: null });
  });

  it("returns authoritative review before applying", async () => {
    const result = await performEditBooking(
      authorizedClient() as never,
      salonId,
      input(),
      { role: "owner", userId: actorUserId },
    );
    expect(result).toMatchObject({
      ok: false,
      error: "sequence_review_required",
      sequenceReview: { requestId, quote: { sequenceFingerprint: fingerprint } },
    });
    expect(mocks.quote).toHaveBeenCalledWith(expect.objectContaining({
      salonId,
      bookingId,
      actorUserId,
      requestId,
    }));
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("replays the same staff operation and preserves explicit email opt-out", async () => {
    const material = input({
      expectedSequenceFingerprint: fingerprint,
      notify: { sms: false, email: false },
    });
    const first = await performEditBooking(
      authorizedClient() as never,
      salonId,
      material,
      { role: "owner", userId: actorUserId },
    );
    mocks.replay.mockResolvedValueOnce({
      ok: true,
      result: { ...committed, idempotent: true },
    });
    const replay = await performEditBooking(
      authorizedClient({
        staff_id: "77777777-7777-4777-8777-777777777777",
        resource_id: "88888888-8888-4888-8888-888888888888",
      }) as never,
      salonId,
      material,
      { role: "owner", userId: actorUserId },
    );
    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.replay).toHaveBeenCalledTimes(2);
    expect(mocks.replay.mock.calls[1]?.[0]).toEqual(mocks.apply.mock.calls[0]?.[0]);
    expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining({ notifyEmail: false }));
    expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining({ notifySms: false }));
    expect(mocks.transitionEmail).not.toHaveBeenCalled();
    expect(mocks.insert).toHaveBeenCalledTimes(2);
    expect(mocks.insert.mock.calls[1]?.[0]).toEqual(mocks.insert.mock.calls[0]?.[0]);
  });

  it("surfaces changed notification material as an idempotency conflict", async () => {
    mocks.replay.mockResolvedValueOnce({ ok: false, code: "idempotency_mismatch" });
    const result = await performEditBooking(
      authorizedClient() as never,
      salonId,
      input({
        expectedSequenceFingerprint: fingerprint,
        notify: { sms: false, email: true },
      }),
      { role: "owner", userId: actorUserId },
    );
    expect(result).toEqual({ ok: false, error: "idempotency_mismatch" });
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("binds a changed SMS choice as an idempotency conflict before apply or enqueue", async () => {
    mocks.replay.mockResolvedValueOnce({ ok: false, code: "idempotency_mismatch" });
    const result = await performEditBooking(
      authorizedClient() as never,
      salonId,
      input({
        expectedSequenceFingerprint: fingerprint,
        notify: { sms: true, email: false },
      }),
      { role: "owner", userId: actorUserId },
    );
    expect(result).toEqual({ ok: false, error: "idempotency_mismatch" });
    expect(mocks.replay).toHaveBeenCalledWith(expect.objectContaining({
      notifyEmail: false,
      notifySms: true,
    }));
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
