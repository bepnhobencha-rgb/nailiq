import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResendFrom: vi.fn(() => "NailIQ <noreply@nailiq.ca>"),
}));

vi.mock("@/shared/lib/resend", () => ({
  getResendClient: vi.fn(),
  getResendFrom: mocks.getResendFrom,
}));

import {
  OWNER_NOTIFICATION_BOOKING_SELECT_COLUMNS,
  ownerNotificationBookingStateEligible,
  ownerNotificationMutationInstant,
  ownerNotificationOccurrenceKey,
  sendToEachRecipient,
} from "@/shared/dashboard/sendOwnerBookingNotification";

const meta = {
  salonId: "11111111-1111-4111-8111-111111111111",
  bookingId: "22222222-2222-4222-8222-222222222222",
  event: "new",
  eventOccurrenceKey: "2026-08-20T01:02:03.000Z",
};
const payload = { subject: "New booking", html: "<p>Booked</p>", text: "Booked" };

function makeHarness() {
  const rpc = vi.fn();
  const insert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn(() => ({ insert }));
  const send = vi.fn();
  const admin = { rpc, from } as never;
  const resend = { emails: { send } } as never;
  return { rpc, insert, from, send, admin, resend };
}

function grantedClaim(claimId = "33333333-3333-4333-8333-333333333333") {
  return {
    data: {
      success: true,
      code: "claimed",
      claimed: true,
      claim_id: claimId,
      status: "sending",
      attempt_count: 1,
    },
    error: null,
  };
}

function completed(status: string) {
  return {
    data: { success: true, code: "completed", status },
    error: null,
  };
}

describe("owner booking notification durable recipient claim", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queries only real production booking timestamp columns", () => {
    expect(OWNER_NOTIFICATION_BOOKING_SELECT_COLUMNS).not.toContain("updated_at");
    expect(OWNER_NOTIFICATION_BOOKING_SELECT_COLUMNS).toEqual(
      expect.arrayContaining([
        "created_at",
        "local_updated_at",
        "rescheduled_at",
        "customer_transitioned_at",
      ]),
    );
  });

  it("uses event-specific persisted timestamps for occurrence fallbacks", () => {
    const booking = {
      localUpdatedAt: "2026-08-28T01:00:00Z",
      rescheduledAt: "2026-08-28T02:00:00Z",
      customerTransitionedAt: "2026-08-28T03:00:00Z",
    };

    expect(ownerNotificationMutationInstant("new", booking)).toBe(
      booking.localUpdatedAt,
    );
    expect(ownerNotificationMutationInstant("reschedule", booking)).toBe(
      booking.rescheduledAt,
    );
    expect(ownerNotificationMutationInstant("cancel", booking)).toBe(
      booking.customerTransitionedAt,
    );
    expect(ownerNotificationMutationInstant("no_show", booking)).toBe(
      booking.customerTransitionedAt,
    );
  });

  it("never sends a cancellation label after the booking was restored", () => {
    expect(ownerNotificationBookingStateEligible("cancel", "cancelled")).toBe(true);
    expect(ownerNotificationBookingStateEligible("cancel", "confirmed")).toBe(false);
    expect(ownerNotificationBookingStateEligible("new", "confirmed")).toBe(true);
  });

  it("claims a normalized deterministic recipient before provider send", async () => {
    const h = makeHarness();
    h.rpc
      .mockResolvedValueOnce(grantedClaim())
      .mockResolvedValueOnce(completed("sent"));
    h.send.mockResolvedValue({
      data: { id: "resend-provider-id-1" },
      error: null,
    });

    await expect(
      sendToEachRecipient(
        h.admin,
        h.resend,
        [" Owner@Example.COM "],
        payload,
        meta,
      ),
    ).resolves.toEqual({ sent: 1, failed: 0 });

    expect(h.rpc).toHaveBeenNthCalledWith(1, "claim_owner_booking_notification", {
      p_salon_id: meta.salonId,
      p_booking_id: meta.bookingId,
      p_event_type: "new",
      p_recipient_identity: "owner@example.com",
      p_event_occurrence_key: "2026-08-20T01:02:03.000Z",
    });
    expect(h.send).toHaveBeenCalledWith(
      {
        from: "NailIQ <noreply@nailiq.ca>",
        to: "owner@example.com",
        ...payload,
        tags: [
          { name: "nailiq_flow", value: "owner_booking" },
          {
            name: "nailiq_claim",
            value: "33333333-3333-4333-8333-333333333333",
          },
        ],
      },
      { idempotencyKey: "owner-booking-33333333-3333-4333-8333-333333333333" },
    );
    expect(h.rpc).toHaveBeenNthCalledWith(2, "complete_owner_booking_notification", {
      p_claim_id: "33333333-3333-4333-8333-333333333333",
      p_status: "sent",
      p_provider_message_id: "resend-provider-id-1",
      p_error: null,
    });
    expect(h.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      h.send.mock.invocationCallOrder[0],
    );
    expect(h.send.mock.invocationCallOrder[0]).toBeLessThan(
      h.rpc.mock.invocationCallOrder[1],
    );
  });

  it.each([
    {
      label: "duplicate/replay",
      claim: {
        data: {
          success: true,
          code: "duplicate_suppressed",
          claimed: false,
        },
        error: null,
      },
    },
    {
      label: "claim RPC error",
      claim: { data: null, error: { message: "db unavailable" } },
    },
    {
      label: "invalid claim response",
      claim: { data: { success: false, code: "invalid_claim" }, error: null },
    },
  ])("makes zero provider calls for $label", async ({ claim }) => {
    const h = makeHarness();
    h.rpc.mockResolvedValueOnce(claim);

    await expect(
      sendToEachRecipient(h.admin, h.resend, ["owner@example.com"], payload, meta),
    ).resolves.toEqual({ sent: 0, failed: 1 });

    expect(h.send).not.toHaveBeenCalled();
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it("finalizes unavailable provider configuration as suppressed", async () => {
    const h = makeHarness();
    h.rpc
      .mockResolvedValueOnce(grantedClaim())
      .mockResolvedValueOnce(completed("suppressed"));

    await expect(
      sendToEachRecipient(h.admin, null, ["owner@example.com"], payload, meta),
    ).resolves.toEqual({ sent: 0, failed: 1 });

    expect(h.send).not.toHaveBeenCalled();
    expect(h.rpc).toHaveBeenNthCalledWith(2, "complete_owner_booking_notification", {
      p_claim_id: "33333333-3333-4333-8333-333333333333",
      p_status: "suppressed",
      p_provider_message_id: null,
      p_error: "no_resend",
    });
  });

  it("finalizes a provider-declared rejection as failed", async () => {
    const h = makeHarness();
    h.rpc
      .mockResolvedValueOnce(grantedClaim())
      .mockResolvedValueOnce(completed("failed"));
    h.send.mockResolvedValue({
      data: null,
      error: { message: "provider rejected request" },
    });

    await sendToEachRecipient(
      h.admin,
      h.resend,
      ["owner@example.com"],
      payload,
      meta,
    );

    expect(h.rpc).toHaveBeenNthCalledWith(2, "complete_owner_booking_notification", {
      p_claim_id: "33333333-3333-4333-8333-333333333333",
      p_status: "failed",
      p_provider_message_id: null,
      p_error: "provider rejected request",
    });
  });

  it("finalizes a thrown or ambiguous provider outcome as unknown", async () => {
    const h = makeHarness();
    h.rpc
      .mockResolvedValueOnce(grantedClaim())
      .mockResolvedValueOnce(completed("unknown"));
    h.send.mockRejectedValue(new Error("connection reset"));

    await sendToEachRecipient(
      h.admin,
      h.resend,
      ["owner@example.com"],
      payload,
      meta,
    );

    expect(h.rpc).toHaveBeenNthCalledWith(2, "complete_owner_booking_notification", {
      p_claim_id: "33333333-3333-4333-8333-333333333333",
      p_status: "unknown",
      p_provider_message_id: null,
      p_error: "provider_exception",
    });
  });

  it("requires a provider receipt before finalizing accepted", async () => {
    const h = makeHarness();
    h.rpc
      .mockResolvedValueOnce(grantedClaim())
      .mockResolvedValueOnce(completed("unknown"));
    h.send.mockResolvedValue({ data: {}, error: null });

    await sendToEachRecipient(
      h.admin,
      h.resend,
      ["owner@example.com"],
      payload,
      meta,
    );

    expect(h.rpc).toHaveBeenNthCalledWith(2, "complete_owner_booking_notification", {
      p_claim_id: "33333333-3333-4333-8333-333333333333",
      p_status: "unknown",
      p_provider_message_id: null,
      p_error: "provider_receipt_missing",
    });
  });

  it("preserves non-booking test/waitlist semantics without using booking RPCs", async () => {
    const h = makeHarness();
    h.send.mockResolvedValue({ data: { id: "test-id" }, error: null });

    await expect(
      sendToEachRecipient(
        h.admin,
        h.resend,
        ["owner@example.com"],
        payload,
        { salonId: meta.salonId, event: "waitlist" },
      ),
    ).resolves.toEqual({ sent: 1, failed: 0 });

    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith({
      from: "NailIQ <noreply@nailiq.ca>",
      to: "owner@example.com",
      ...payload,
    });
  });

  it("binds leased waitlist delivery to a PII-free provider idempotency key", async () => {
    const h = makeHarness();
    h.send.mockResolvedValue({ data: { id: "waitlist-provider-id" }, error: null });
    const deliveryId = "33333333-3333-4333-8333-333333333333";

    await expect(
      sendToEachRecipient(
        h.admin,
        h.resend,
        ["owner@example.com"],
        payload,
        { salonId: meta.salonId, event: "waitlist", waitlistDeliveryId: deliveryId },
      ),
    ).resolves.toEqual({ sent: 1, failed: 0 });

    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledWith(
      {
        from: "NailIQ <noreply@nailiq.ca>",
        to: "owner@example.com",
        ...payload,
        tags: [
          { name: "nailiq_flow", value: "owner_waitlist" },
          { name: "nailiq_delivery", value: deliveryId },
        ],
      },
      {
        idempotencyKey: expect.stringMatching(
          new RegExp(`^owner-waitlist-${deliveryId}-[0-9a-f]{16}$`),
        ),
      },
    );
  });

  it("derives bounded deterministic occurrence keys from authoritative booking timestamps", () => {
    expect(
      ownerNotificationOccurrenceKey("new", {
        createdAt: "2026-08-20T01:02:03Z",
      }),
    ).toBe("2026-08-20T01:02:03.000Z");
    expect(
      ownerNotificationOccurrenceKey("reschedule", {
        startTimeUtc: "2026-09-01T10:30:00-07:00",
        updatedAt: "2026-08-20T02:03:04Z",
      }),
    ).toBe("2026-09-01T17:30:00.000Z|2026-08-20T02:03:04.000Z");
    expect(
      ownerNotificationOccurrenceKey("cancel", {
        updatedAt: "2026-08-20T02:03:04Z",
      }),
    ).toBe("2026-08-20T02:03:04.000Z");
    expect(
      ownerNotificationOccurrenceKey("no_show", { updatedAt: "invalid" }),
    ).toBeNull();
  });

  it("dedupes an exact reschedule retry but distinguishes A to B to A", () => {
    const firstMoveToB = ownerNotificationOccurrenceKey("reschedule", {
      startTimeUtc: "2026-09-02T18:00:00.000Z",
      updatedAt: "2026-08-20T03:00:00.000Z",
    });
    const exactRetry = ownerNotificationOccurrenceKey("reschedule", {
      startTimeUtc: "2026-09-02T18:00:00Z",
      updatedAt: "2026-08-20T03:00:00Z",
    });
    const moveBackToA = ownerNotificationOccurrenceKey("reschedule", {
      startTimeUtc: "2026-09-01T18:00:00.000Z",
      updatedAt: "2026-08-20T04:00:00.000Z",
    });
    const laterMoveBackToB = ownerNotificationOccurrenceKey("reschedule", {
      startTimeUtc: "2026-09-02T18:00:00.000Z",
      updatedAt: "2026-08-20T05:00:00.000Z",
    });

    expect(exactRetry).toBe(firstMoveToB);
    expect(moveBackToA).not.toBe(firstMoveToB);
    expect(laterMoveBackToB).not.toBe(firstMoveToB);
  });

  it("fails closed when a booking event occurrence key is absent", async () => {
    const h = makeHarness();

    await expect(
      sendToEachRecipient(
        h.admin,
        h.resend,
        ["owner@example.com"],
        payload,
        { salonId: meta.salonId, bookingId: meta.bookingId, event: "new" },
      ),
    ).resolves.toEqual({ sent: 0, failed: 1 });

    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("does not report durable success when claim completion fails", async () => {
    const h = makeHarness();
    h.rpc
      .mockResolvedValueOnce(grantedClaim())
      .mockResolvedValueOnce({ data: null, error: { message: "db unavailable" } });
    h.send.mockResolvedValue({
      data: { id: "resend-provider-id-1" },
      error: null,
    });

    await expect(
      sendToEachRecipient(
        h.admin,
        h.resend,
        ["owner@example.com"],
        payload,
        meta,
      ),
    ).resolves.toEqual({ sent: 0, failed: 1 });

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        resend_id: "resend-provider-id-1",
        error: "claim_completion_failed:provider_accepted",
      }),
    );
  });

  it("rejects an already-completed claim whose durable status disagrees", async () => {
    const h = makeHarness();
    h.rpc
      .mockResolvedValueOnce(grantedClaim())
      .mockResolvedValueOnce({
        data: {
          success: true,
          code: "already_completed",
          status: "unknown",
        },
        error: null,
      });
    h.send.mockResolvedValue({
      data: { id: "resend-provider-id-1" },
      error: null,
    });

    await expect(
      sendToEachRecipient(
        h.admin,
        h.resend,
        ["owner@example.com"],
        payload,
        meta,
      ),
    ).resolves.toEqual({ sent: 0, failed: 1 });

    expect(h.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        resend_id: "resend-provider-id-1",
        error: "claim_completion_failed:provider_accepted",
      }),
    );
  });

  it("redacts recipient PII and sanitizes provider errors in runtime logs", async () => {
    const h = makeHarness();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    h.rpc
      .mockResolvedValueOnce(grantedClaim())
      .mockResolvedValueOnce(completed("unknown"));
    h.send.mockRejectedValue(
      new Error("owner@example.com +16045101234 connection reset"),
    );

    await sendToEachRecipient(
      h.admin,
      h.resend,
      ["owner@example.com"],
      payload,
      meta,
    );

    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).toContain("recipient:");
    expect(logged).toContain("[email]");
    expect(logged).toContain("[phone]");
    expect(logged).not.toContain("owner@example.com");
    expect(logged).not.toContain("16045101234");
  });
});
