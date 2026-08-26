import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  inspect: vi.fn(),
  genericReschedule: vi.fn(),
  quoteSequence: vi.fn(),
  rescheduleSequence: vi.fn(),
  rate: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: mocks.after };
});
vi.mock("@/shared/booking/bookingManagementCapabilities", () => ({
  inspectBookingManagementCapability: mocks.inspect,
  rescheduleBookingWithManagementCapability: mocks.genericReschedule,
}));
vi.mock("@/shared/booking/bookingSequenceReschedule", () => ({
  quoteBookingSequenceReschedule: mocks.quoteSequence,
  rescheduleBookingSequenceWithManagementCapability: mocks.rescheduleSequence,
}));
vi.mock("@/shared/booking/bookingManagementRateLimit", () => ({
  consumeBookingManagementRateLimit: mocks.rate,
}));
vi.mock("@/shared/dashboard/reconcilePublicBookingManagementAudit", () => ({
  reconcilePublicBookingManagementAudit: mocks.audit,
}));
vi.mock("@/shared/dashboard/sendOwnerBookingNotification", () => ({
  sendOwnerBookingNotification: vi.fn(),
}));
vi.mock("@/shared/noshow/deliverPromotedWaitlistOffer", () => ({
  deliverPromotedWaitlistOffer: vi.fn(),
}));
vi.mock("@/shared/notifications/customerBookingTransitionEmail", () => ({
  deliverCustomerBookingTransitionEmail: vi.fn(),
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: {
              opening_hours: {
                mon: { open: "09:00", close: "18:00", closed: false },
                tue: { open: "09:00", close: "18:00", closed: false },
                wed: { open: "09:00", close: "18:00", closed: false },
                thu: { open: "09:00", close: "18:00", closed: false },
                fri: { open: "09:00", close: "18:00", closed: false },
                sat: { open: "09:00", close: "18:00", closed: false },
                sun: { open: "09:00", close: "18:00", closed: true },
              },
              booking_closed_dates: [],
            },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

import { POST } from "@/app/api/booking/reschedule-action/route";

const token = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const bookingId = "33333333-3333-4333-8333-333333333333";
const salonId = "44444444-4444-4444-8444-444444444444";
const newStartUtc = "2026-08-24T11:00:00.000Z";
const newEndUtc = "2026-08-24T12:00:00.000Z";
const fingerprint = "a".repeat(64);

const inspection = {
  ok: true,
  inspection: {
    booking: { scheduleModel: "segments_v1" },
    context: {
      salonId,
      timezone: "UTC",
      durationMinutes: 60,
    },
  },
};

const quote = {
  requestId,
  bookingId,
  salonId,
  sequenceFingerprint: fingerprint,
  parentStartTimeUtc: newStartUtc,
  parentEndTimeUtc: newEndUtc,
  segments: [],
};

const committed = {
  bookingId,
  salonId,
  previousStartTimeUtc: "2026-08-23T18:00:00.000Z",
  startTimeUtc: newStartUtc,
  endTimeUtc: newEndUtc,
  transitionVersion: 2,
  sequenceFingerprint: fingerprint,
  receipt: {
    segments: [{ serviceName: "Gel" }, { serviceName: "Art" }],
  },
  cancelPreview: { policyLockedByReschedule: false },
  promotedWaitlist: null,
  idempotent: false,
};

function request(expectedSequenceFingerprint?: string) {
  return new Request("http://localhost/api/booking/reschedule-action", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({
      token,
      requestId,
      date: "2026-08-24",
      slotLabel: "11:00 AM",
      newStartUtc,
      newEndUtc,
      ...(expectedSequenceFingerprint ? { expectedSequenceFingerprint } : {}),
    }),
  });
}

describe("full-sequence customer reschedule transition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.after.mockImplementation(() => undefined);
    mocks.rate.mockResolvedValue("allowed");
    mocks.audit.mockResolvedValue(undefined);
    mocks.inspect.mockResolvedValue(inspection);
    mocks.quoteSequence.mockResolvedValue({ ok: true, quote });
    mocks.rescheduleSequence.mockResolvedValue({ ok: true, result: committed });
  });

  it("quotes the entire sequence before any mutation", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      code: "sequence_review_required",
      sequenceQuote: { sequenceFingerprint: fingerprint },
    });
    expect(mocks.quoteSequence).toHaveBeenCalledWith({
      tokenId: token,
      requestId,
      newStartTimeUtc: newStartUtc,
    });
    expect(mocks.rescheduleSequence).not.toHaveBeenCalled();
    expect(mocks.genericReschedule).not.toHaveBeenCalled();
  });

  it("applies once and exact consumed-token replay reaches the same sequence RPC", async () => {
    const first = await POST(request(fingerprint));
    mocks.inspect.mockResolvedValueOnce({ ok: false, code: "token_consumed" });
    mocks.rescheduleSequence.mockResolvedValueOnce({
      ok: true,
      result: { ...committed, idempotent: true },
    });
    const replay = await POST(request(fingerprint));
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      ok: true,
      idempotent: true,
      serviceName: "Gel + Art",
    });
    expect(mocks.rescheduleSequence).toHaveBeenCalledTimes(2);
    expect(mocks.rescheduleSequence.mock.calls[1]?.[0])
      .toEqual(mocks.rescheduleSequence.mock.calls[0]?.[0]);
    expect(mocks.genericReschedule).not.toHaveBeenCalled();
  });

  it("returns fresh review material on pricing change without side effects", async () => {
    mocks.rescheduleSequence.mockResolvedValueOnce({
      ok: false,
      code: "pricing_changed",
      quote: { ...quote, sequenceFingerprint: "b".repeat(64) },
    });
    const response = await POST(request(fingerprint));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "pricing_changed",
      quote: { sequenceFingerprint: "b".repeat(64) },
    });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("rejects a nonexistent spring-forward wall slot before mutation", async () => {
    mocks.inspect.mockResolvedValueOnce({
      ...inspection,
      inspection: {
        ...inspection.inspection,
        booking: { scheduleModel: "single" },
        context: {
          ...inspection.inspection.context,
          timezone: "America/Vancouver",
        },
      },
    });
    const response = await POST(new Request("http://localhost/api/booking/reschedule-action", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        token,
        requestId,
        date: "2026-03-08",
        slotLabel: "2:30 AM",
        newStartUtc: "2026-03-08T10:30:00.000Z",
        newEndUtc: "2026-03-08T11:30:00.000Z",
      }),
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false, code: "invalid_slot" });
    expect(mocks.genericReschedule).not.toHaveBeenCalled();
    expect(mocks.rescheduleSequence).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
