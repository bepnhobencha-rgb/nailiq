import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDashboardWriteClient: vi.fn(),
  isArchivedBookingFeatureAvailable: vi.fn(),
  createServiceRoleClient: vi.fn(),
  runCancelledBookingRemainingDepositRefund: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/dashboard/setupActions", () => ({
  getDashboardWriteClient: mocks.getDashboardWriteClient,
}));
vi.mock("@/shared/dashboard/archivedBookingFeatureAccess", () => ({
  isArchivedBookingFeatureAvailable:
    mocks.isArchivedBookingFeatureAvailable,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock("@/shared/payments/executeBookingPaymentOperation", () => ({
  runCancelledBookingRemainingDepositRefund:
    mocks.runCancelledBookingRemainingDepositRefund,
}));

import { refundCancelledBookingDepositRemaining } from "@/shared/dashboard/refundCancelledBookingDepositAction";

const SALON_ID = "11111111-1111-4111-8111-111111111111";
const BOOKING_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const OPERATION_ID = "55555555-5555-4555-8555-555555555555";
const SLUG = "refund-qa";
const EXPECTED_REMAINING_CENTS = 3_000;

type BookingRead = {
  data: { id: string; status: string } | null;
  error: unknown;
};

function bookingQuery(result: BookingRead) {
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.maybeSingle.mockResolvedValue(result);
  return chain;
}

describe("refundCancelledBookingDepositRemaining", () => {
  let query: ReturnType<typeof bookingQuery>;
  let from: ReturnType<typeof vi.fn>;
  const serviceDb = { rpc: vi.fn() };

  function setContext(
    overrides: Partial<{
      kind: "member" | "demo_cookie";
      role: "owner" | "admin" | "senior" | "receptionist" | "nail_tech";
      userId: string | null;
    }> = {},
  ) {
    mocks.getDashboardWriteClient.mockResolvedValue({
      kind: "member",
      role: "owner",
      userId: USER_ID,
      salon: { id: SALON_ID },
      supabase: { from },
      ...overrides,
    });
  }

  async function run() {
    return refundCancelledBookingDepositRemaining(SLUG, {
      bookingId: BOOKING_ID,
      requestId: REQUEST_ID,
      expectedRemainingCents: EXPECTED_REMAINING_CENTS,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    query = bookingQuery({
      data: { id: BOOKING_ID, status: "cancelled" },
      error: null,
    });
    from = vi.fn(() => query);
    setContext();
    mocks.isArchivedBookingFeatureAvailable.mockResolvedValue(true);
    mocks.createServiceRoleClient.mockReturnValue(serviceDb);
    mocks.runCancelledBookingRemainingDepositRefund.mockResolvedValue({
      ok: true,
      status: "succeeded",
      operationId: OPERATION_ID,
      providerReceipt: "refund_qa",
    });
  });

  it.each([
    ["blank slug", "", BOOKING_ID, REQUEST_ID, EXPECTED_REMAINING_CENTS, "invalid_booking"],
    ["invalid booking UUID", SLUG, "booking-1", REQUEST_ID, EXPECTED_REMAINING_CENTS, "invalid_booking"],
    ["invalid request UUID", SLUG, BOOKING_ID, "request-1", EXPECTED_REMAINING_CENTS, "invalid_request"],
    ["zero remaining", SLUG, BOOKING_ID, REQUEST_ID, 0, "invalid_request"],
    ["fractional remaining", SLUG, BOOKING_ID, REQUEST_ID, 2.5, "invalid_request"],
  ])(
    "rejects %s before resolving dashboard identity",
    async (_label, slug, bookingId, requestId, expectedRemainingCents, error) => {
      await expect(
        refundCancelledBookingDepositRemaining(slug as string, {
          bookingId: bookingId as string,
          requestId: requestId as string,
          expectedRemainingCents: expectedRemainingCents as number,
        }),
      ).resolves.toEqual({ ok: false, error });
      expect(mocks.getDashboardWriteClient).not.toHaveBeenCalled();
      expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
      expect(mocks.runCancelledBookingRemainingDepositRefund).not.toHaveBeenCalled();
    },
  );

  it("returns unauthorized when no authenticated salon context exists", async () => {
    mocks.getDashboardWriteClient.mockResolvedValue(null);

    await expect(run()).resolves.toEqual({ ok: false, error: "unauthorized" });
    expect(mocks.isArchivedBookingFeatureAvailable).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it.each([
    ["demo cookie", { kind: "demo_cookie" as const, role: "owner" as const }],
    ["senior", { kind: "member" as const, role: "senior" as const }],
    ["receptionist", { kind: "member" as const, role: "receptionist" as const }],
    ["nail tech", { kind: "member" as const, role: "nail_tech" as const }],
  ])(
    "rejects %s before feature, service-role, or payment work",
    async (_label, context) => {
      setContext(context);

      await expect(run()).resolves.toEqual({ ok: false, error: "forbidden" });
      expect(mocks.isArchivedBookingFeatureAvailable).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
      expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
      expect(mocks.runCancelledBookingRemainingDepositRefund).not.toHaveBeenCalled();
    },
  );

  it.each(["owner", "admin"] as const)(
    "allows %s and preserves the stable request plus confirmed amount",
    async (role) => {
      setContext({ role });

      await expect(run()).resolves.toEqual({ ok: true, status: "succeeded" });
      expect(mocks.isArchivedBookingFeatureAvailable).toHaveBeenCalledWith(
        expect.objectContaining({ id: SALON_ID }),
      );
      expect(from).toHaveBeenCalledExactlyOnceWith("bookings");
      expect(query.select).toHaveBeenCalledExactlyOnceWith("id, status");
      expect(query.eq.mock.calls).toEqual([
        ["id", BOOKING_ID],
        ["salon_id", SALON_ID],
      ]);
      expect(mocks.createServiceRoleClient).toHaveBeenCalledTimes(1);
      expect(
        mocks.runCancelledBookingRemainingDepositRefund,
      ).toHaveBeenCalledExactlyOnceWith({
        db: serviceDb,
        salonId: SALON_ID,
        bookingId: BOOKING_ID,
        requestId: REQUEST_ID,
        expectedRemainingCents: EXPECTED_REMAINING_CENTS,
      });
    },
  );

  it("fails closed when the feature is disabled", async () => {
    mocks.isArchivedBookingFeatureAvailable.mockResolvedValue(false);

    await expect(run()).resolves.toEqual({ ok: false, error: "feature_disabled" });
    expect(from).toHaveBeenCalledExactlyOnceWith("bookings");
    expect(query.eq.mock.calls).toEqual([
      ["id", BOOKING_ID],
      ["salon_id", SALON_ID],
    ]);
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
    expect(mocks.runCancelledBookingRemainingDepositRefund).not.toHaveBeenCalled();
  });

  it("returns not_found for a booking outside the caller's salon", async () => {
    query.maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(run()).resolves.toEqual({ ok: false, error: "not_found" });
    expect(query.eq.mock.calls).toEqual([
      ["id", BOOKING_ID],
      ["salon_id", SALON_ID],
    ]);
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
    expect(mocks.runCancelledBookingRemainingDepositRefund).not.toHaveBeenCalled();
  });

  it("rejects a non-cancelled booking before service-role or payment work", async () => {
    query.maybeSingle.mockResolvedValue({
      data: { id: BOOKING_ID, status: "confirmed" },
      error: null,
    });

    await expect(run()).resolves.toEqual({ ok: false, error: "not_cancelled" });
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
    expect(mocks.runCancelledBookingRemainingDepositRefund).not.toHaveBeenCalled();
  });

  it("fails closed on a tenant booking read error", async () => {
    query.maybeSingle.mockResolvedValue({
      data: null,
      error: new Error("read unavailable"),
    });

    await expect(run()).resolves.toEqual({ ok: false, error: "server_error" });
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
    expect(mocks.runCancelledBookingRemainingDepositRefund).not.toHaveBeenCalled();
  });

  it("fails closed when the server-only database client is unavailable", async () => {
    mocks.createServiceRoleClient.mockImplementation(() => {
      throw new Error("service role unavailable");
    });

    await expect(run()).resolves.toEqual({ ok: false, error: "server_error" });
    expect(mocks.runCancelledBookingRemainingDepositRefund).not.toHaveBeenCalled();
  });

  it.each([
    ["pending_provider", "in_flight", "reconciliation_required"],
    ["unknown", "completion_write_uncertain", "reconciliation_required"],
    ["definite_failure", "card_declined", "provider_failed"],
    ["not_claimed", "operation_conflict", "request_conflict"],
    ["not_claimed", "payment_replay_material_conflict", "request_conflict"],
    ["not_claimed", "refund_remaining_changed", "refund_changed"],
    ["not_claimed", "refund_amount_exceeds_remaining", "refund_changed"],
    ["not_claimed", "amount_changed", "refund_changed"],
    ["not_claimed", "booking_not_cancelled", "not_cancelled"],
    ["not_claimed", "refund_reconciliation_required", "reconciliation_required"],
    ["not_claimed", "deposit_fully_refunded", "not_refundable"],
    ["not_claimed", "deposit_not_refundable", "not_refundable"],
    ["not_claimed", "legacy_payment_not_ledgered", "not_refundable"],
    ["not_claimed", "parent_payment_binding_mismatch", "not_refundable"],
    ["not_claimed", "payment_claim_unavailable", "server_error"],
  ])(
    "maps runner %s/%s to %s",
    async (status, reason, error) => {
      mocks.runCancelledBookingRemainingDepositRefund.mockResolvedValue({
        ok: false,
        status,
        operationId: OPERATION_ID,
        reason,
      });

      await expect(run()).resolves.toEqual({ ok: false, error });
    },
  );
});
