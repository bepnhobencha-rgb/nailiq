import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  inspect: vi.fn(),
  cancel: vi.fn(),
  rate: vi.fn(),
  audit: vi.fn(),
  transition: vi.fn(),
  owner: vi.fn(),
  waitlist: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: mocks.after };
});
vi.mock("@/shared/booking/bookingManagementCapabilities", () => ({
  inspectBookingManagementCapability: mocks.inspect,
  cancelBookingWithManagementCapability: mocks.cancel,
}));
vi.mock("@/shared/booking/bookingManagementRateLimit", () => ({
  consumeBookingManagementRateLimit: mocks.rate,
}));
vi.mock("@/shared/dashboard/reconcilePublicBookingManagementAudit", () => ({
  reconcilePublicBookingManagementAudit: mocks.audit,
}));
vi.mock("@/shared/notifications/customerBookingTransitionEmail", () => ({
  deliverCustomerBookingTransitionEmail: mocks.transition,
}));
vi.mock("@/shared/dashboard/sendOwnerBookingNotification", () => ({
  sendOwnerBookingNotification: mocks.owner,
}));
vi.mock("@/shared/noshow/deliverPromotedWaitlistOffer", () => ({
  deliverPromotedWaitlistOffer: mocks.waitlist,
}));

import { GET, POST } from "./route";

const TOKEN = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const cancelPreview = {
  startPast: false,
  withinWindow: true,
  willCharge: true,
  policyLockedByReschedule: true,
  feeCents: 2500,
  cardLast4: "4242",
  cardBrand: "visa",
  currency: "CAD",
};
const inspection = {
  ok: true,
  inspection: {
    scopeKind: "booking_own",
    context: { groupId: null },
    cancelPreview,
    booking: { salonSlug: "qa-salon" },
  },
};
const committed = {
  bookingId: "33333333-3333-4333-8333-333333333333",
  salonId: "44444444-4444-4444-8444-444444444444",
  salonSlug: "qa-salon",
  code: "cancelled",
  groupId: null,
  scopeKind: "booking_own",
  rsvpSemantic: null,
  attendanceStatus: null,
  cancelPreview,
  transitionVersion: 7,
  promotedWaitlist: {
    waitlistEntryId: "55555555-5555-4555-8555-555555555555",
    claimCapabilityToken: "66666666-6666-4666-8666-666666666666",
    offerEpoch: 2,
    expiresAt: "2099-08-20T17:20:00.000Z",
  },
  idempotent: false,
};

function postRequest(origin = "https://nailiq.test") {
  const body = JSON.stringify({ token: TOKEN, requestId: REQUEST_ID });
  return new Request("https://nailiq.test/api/booking/cancel-action", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
    },
    body,
  });
}

describe("cancel management runtime behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rate.mockResolvedValue("allowed");
    mocks.inspect.mockResolvedValue(inspection);
    mocks.cancel.mockResolvedValue({ ok: true, result: committed });
    mocks.audit.mockResolvedValue(undefined);
  });

  it("keeps GET inspection-only and never charges or consumes", async () => {
    const response = await GET(new Request(`https://nailiq.test/api/booking/cancel-action?token=${TOKEN}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, feeCents: 2500, salonSlug: "qa-salon" });
    expect(mocks.inspect).toHaveBeenCalledWith({ tokenId: TOKEN, expectedAction: "cancel" });
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("fails cross-origin POST before capability, charge, or provider-adjacent work", async () => {
    const response = await POST(postRequest("https://evil.test"));
    expect(response.status).toBe(403);
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("recovers response loss with the same request and keeps the fee awaiting approval", async () => {
    const first = await POST(postRequest());
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      ok: true,
      bookingCommitted: true,
      feeCharged: false,
      feeStatus: "approval_required",
      feeCents: 2500,
    });

    mocks.inspect.mockResolvedValueOnce({ ok: false, code: "token_consumed" });
    mocks.cancel.mockResolvedValueOnce({ ok: true, result: { ...committed, idempotent: true } });
    const replay = await POST(postRequest());
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      ok: true,
      bookingCommitted: true,
      feeCharged: false,
      feeStatus: "approval_required",
      feeCents: 2500,
      idempotent: true,
    });
    expect(mocks.cancel).toHaveBeenNthCalledWith(1, { tokenId: TOKEN, requestId: REQUEST_ID });
    expect(mocks.cancel).toHaveBeenNthCalledWith(2, { tokenId: TOKEN, requestId: REQUEST_ID });
  });

  it("never turns a committed cancellation into a payment error or provider call", async () => {
    const response = await POST(postRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      bookingCommitted: true,
      feeCharged: false,
      feeStatus: "approval_required",
      feeCents: 2500,
      currency: "CAD",
    });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        fee_decision: "approval_required",
        fee_cents: 2500,
      }),
    }));
  });

  it("fails closed when the durable cancellation receipt lacks its fee snapshot", async () => {
    mocks.cancel.mockResolvedValueOnce({ ok: true, result: { ...committed, cancelPreview: null } });
    const response = await POST(postRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, code: "invalid_management_response" });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("never charges a member-own RSVP decline even when the salon snapshot has a late fee and card", async () => {
    mocks.cancel.mockResolvedValueOnce({
      ok: true,
      result: {
        ...committed,
        groupId: "77777777-7777-4777-8777-777777777777",
        scopeKind: "member_own",
        rsvpSemantic: "decline",
        attendanceStatus: "declined",
      },
    });

    const response = await POST(postRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      code: "declined",
      rsvpSemantic: "decline",
      attendanceStatus: "declined",
      feeCharged: false,
      feeCents: 0,
    });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      bookingId: committed.bookingId,
      payload: expect.objectContaining({
        rsvp_semantic: "decline",
        fee_decision: "rsvp_no_charge",
        fee_cents: 0,
      }),
    }));
  });

  it("never charges an organizer-own RSVP decline or expands it to the whole party", async () => {
    mocks.cancel.mockResolvedValueOnce({
      ok: true,
      result: {
        ...committed,
        groupId: "77777777-7777-4777-8777-777777777777",
        scopeKind: "organizer_own",
        rsvpSemantic: "decline",
        attendanceStatus: "declined",
      },
    });

    const response = await POST(postRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      code: "declined",
      rsvpSemantic: "decline",
      attendanceStatus: "declined",
      feeCharged: false,
      feeCents: 0,
    });
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "rsvp_decline",
      payload: expect.objectContaining({ fee_decision: "rsvp_no_charge" }),
    }));
  });
});
