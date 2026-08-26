import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvePaymentProvider: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/integrations/payments", () => ({
  resolvePaymentProvider: mocks.resolvePaymentProvider,
}));

import { runCancelledBookingRemainingDepositRefund } from "@/shared/payments/executeBookingPaymentOperation";

const SALON_ID = "11111111-1111-4111-8111-111111111111";
const BOOKING_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";

describe("runCancelledBookingRemainingDepositRefund replay boundary", () => {
  const rpc = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the stored receipt for an exact stable-request replay without a provider call", async () => {
    rpc.mockResolvedValue({
      data: {
        success: true,
        code: "operation_replay",
        status: "succeeded",
        operation_id: OPERATION_ID,
        result: { provider_refund_id: "refund_stable_qa" },
      },
      error: null,
    });

    await expect(
      runCancelledBookingRemainingDepositRefund({
        db: { rpc },
        salonId: SALON_ID,
        bookingId: BOOKING_ID,
        requestId: REQUEST_ID,
        expectedRemainingCents: 3_000,
      }),
    ).resolves.toEqual({
      ok: true,
      status: "succeeded",
      operationId: OPERATION_ID,
      providerReceipt: "refund_stable_qa",
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      "claim_cancelled_booking_remaining_deposit_refund",
      {
        p_salon_id: SALON_ID,
        p_booking_id: BOOKING_ID,
        p_request_id: REQUEST_ID,
        p_expected_remaining_cents: 3_000,
      },
    );
    expect(mocks.resolvePaymentProvider).not.toHaveBeenCalled();
  });

  it("rejects a changed confirmed amount without resolving or calling a provider", async () => {
    rpc.mockResolvedValue({
      data: {
        success: false,
        code: "refund_remaining_changed",
        operation_id: OPERATION_ID,
      },
      error: null,
    });

    await expect(
      runCancelledBookingRemainingDepositRefund({
        db: { rpc },
        salonId: SALON_ID,
        bookingId: BOOKING_ID,
        requestId: REQUEST_ID,
        expectedRemainingCents: 2_999,
      }),
    ).resolves.toEqual({
      ok: false,
      status: "not_claimed",
      operationId: OPERATION_ID,
      reason: "refund_remaining_changed",
    });
    expect(mocks.resolvePaymentProvider).not.toHaveBeenCalled();
  });

  it("maps a durable failed replay without retrying the provider", async () => {
    rpc.mockResolvedValue({
      data: {
        success: false,
        code: "operation_failed",
        status: "failed",
        operation_id: OPERATION_ID,
        error_code: "card_declined",
      },
      error: null,
    });

    await expect(
      runCancelledBookingRemainingDepositRefund({
        db: { rpc },
        salonId: SALON_ID,
        bookingId: BOOKING_ID,
        requestId: REQUEST_ID,
        expectedRemainingCents: 3_000,
      }),
    ).resolves.toEqual({
      ok: false,
      status: "definite_failure",
      operationId: OPERATION_ID,
      reason: "card_declined",
    });
    expect(mocks.resolvePaymentProvider).not.toHaveBeenCalled();
  });

  it.each([
    [{ data: null, error: new Error("rpc unavailable") }],
    [new Error("transport unavailable")],
  ])("fails closed when the atomic claim is unavailable", async (failure) => {
    if (failure instanceof Error) rpc.mockRejectedValue(failure);
    else rpc.mockResolvedValue(failure);

    await expect(
      runCancelledBookingRemainingDepositRefund({
        db: { rpc },
        salonId: SALON_ID,
        bookingId: BOOKING_ID,
        requestId: REQUEST_ID,
        expectedRemainingCents: 3_000,
      }),
    ).resolves.toEqual({
      ok: false,
      status: "not_claimed",
      operationId: null,
      reason: "payment_claim_unavailable",
    });
    expect(mocks.resolvePaymentProvider).not.toHaveBeenCalled();
  });
});
