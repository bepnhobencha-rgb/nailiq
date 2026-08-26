import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock("../executeBookingPaymentOperation", () => ({
  dispatchClaimedBookingPaymentOperation: mocks.dispatch,
}));

import { cancelDeskBookingWithRefundSaga } from "../deskCancelRefundSaga";

const SALON_ID = "11111111-1111-4111-8111-111111111111";
const BOOKING_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";
const ATTEMPT_TOKEN = "55555555-5555-4555-8555-555555555555";
const PARENT_OPERATION_ID = "66666666-6666-4666-8666-666666666666";
const ACTOR_ID = "77777777-7777-4777-8777-777777777777";
const MATERIAL_FP = "a".repeat(64);
const ACCOUNT_FP = createHash("sha256")
  .update("square:merchant_qa:location_qa:sandbox", "utf8")
  .digest("hex");

const input = {
  salonId: SALON_ID,
  bookingId: BOOKING_ID,
  requestId: REQUEST_ID,
  amountCents: 2_500,
  notifyEmail: false,
  notificationNotBefore: null,
};

function cancellationResult() {
  return {
    status: "cancelled",
    customer_transition_version: 7,
    promoted_waitlist: null,
  };
}

function refundMaterial() {
  return {
    salon_id: SALON_ID,
    booking_id: BOOKING_ID,
    operation_kind: "deposit_refund",
    provider: "square",
    provider_account_fingerprint: ACCOUNT_FP,
    amount_cents: 2_500,
    currency: "CAD",
    parent_payment_id: "square-payment-qa",
    parent_operation_id: PARENT_OPERATION_ID,
    operation_occurrence_version: null,
    captured_cents: 5_000,
    refunded_cents: 0,
    reserved_cents: 2_500,
    remaining_refundable_cents: 2_500,
  };
}

function providerMaterial() {
  return {
    provider_account_id: "merchant_qa",
    provider_location_id: "location_qa",
    provider_environment: "sandbox",
    currency: "CAD",
    saved_card_id: null,
    customer_id: null,
    parent_payment_id: "square-payment-qa",
  };
}

function sagaRow(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    code: "cancelled_refund_claimed",
    idempotent: false,
    saga_status: "refund_claimed",
    salon_id: SALON_ID,
    booking_id: BOOKING_ID,
    cancellation_transition_version: 7,
    cancellation_result: cancellationResult(),
    refund_operation_id: OPERATION_ID,
    refund_status: "sending",
    refund_material_fingerprint: MATERIAL_FP,
    refund_material: refundMaterial(),
    provider_material: providerMaterial(),
    provider_idempotency_key: `nq:${OPERATION_ID}`,
    attempt_token: ATTEMPT_TOKEN,
    lease_expires_at: "2026-08-20T23:00:00.000Z",
    ...overrides,
  };
}

describe("desk cancel + deposit refund saga runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the single atomic DB saga and dispatches only its DB-owned first claim", async () => {
    mocks.rpc.mockResolvedValue({ data: sagaRow(), error: null });
    mocks.dispatch.mockResolvedValue({
      ok: true,
      status: "succeeded",
      operationId: OPERATION_ID,
      providerReceipt: "refund_qa",
    });

    await expect(cancelDeskBookingWithRefundSaga(input)).resolves.toMatchObject({
      ok: true,
      idempotent: false,
      refundStatus: "succeeded",
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "cancel_booking_with_deposit_refund_saga",
      {
        p_salon_id: SALON_ID,
        p_booking_id: BOOKING_ID,
        p_saga_request_id: REQUEST_ID,
        p_refund_amount_cents: 2_500,
        p_notify_email: false,
        p_notification_not_before: null,
      },
    );
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      claim: expect.objectContaining({
        operationId: OPERATION_ID,
        providerIdempotencyKey: `nq:${OPERATION_ID}`,
        material: expect.objectContaining({
          salonId: SALON_ID,
          bookingId: BOOKING_ID,
          amountCents: 2_500,
          operationKind: "deposit_refund",
        }),
      }),
    }));
  });

  it("binds member actor and both requested channels through the atomic desk wrapper", async () => {
    mocks.rpc.mockResolvedValue({
      data: sagaRow({ saga_status: "refunded", refund_status: "succeeded" }),
      error: null,
    });

    await expect(cancelDeskBookingWithRefundSaga({
      ...input,
      actorUserId: ACTOR_ID,
      notifyEmail: true,
      notifySms: true,
      notificationNotBefore: "2026-08-20T23:00:20.000Z",
    })).resolves.toMatchObject({ ok: true, refundStatus: "succeeded" });

    expect(mocks.rpc).toHaveBeenCalledWith(
      "cancel_booking_with_deposit_refund_saga_for_desk",
      {
        p_salon_id: SALON_ID,
        p_booking_id: BOOKING_ID,
        p_saga_request_id: REQUEST_ID,
        p_refund_amount_cents: 2_500,
        p_notify_email: true,
        p_notify_sms: true,
        p_actor_user_id: ACTOR_ID,
        p_notification_not_before: "2026-08-20T23:00:20.000Z",
      },
    );
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["refunded", "succeeded", "succeeded"],
    ["refund_pending", "pending_provider", "pending_provider"],
    ["refund_unknown", "unknown", "unknown"],
    ["refund_failed", "failed", "definite_failure"],
  ] as const)(
    "replays durable %s/%s without another provider dispatch",
    async (sagaStatus, refundStatus, expected) => {
      mocks.rpc.mockResolvedValue({
        data: sagaRow({
          code: "saga_replay",
          idempotent: true,
          saga_status: sagaStatus,
          refund_status: refundStatus,
          attempt_token: null,
        }),
        error: null,
      });

      await expect(cancelDeskBookingWithRefundSaga(input)).resolves.toMatchObject({
        ok: true,
        idempotent: true,
        refundStatus: expected,
      });
      expect(mocks.dispatch).not.toHaveBeenCalled();
    },
  );

  it("resumes a response-lost cancellation only when replay still grants the persisted claim", async () => {
    mocks.rpc.mockResolvedValue({
      data: sagaRow({ code: "saga_replay", idempotent: true }),
      error: null,
    });
    mocks.dispatch.mockResolvedValue({
      ok: false,
      status: "pending_provider",
      operationId: OPERATION_ID,
      reason: "provider_pending",
    });

    await expect(cancelDeskBookingWithRefundSaga(input)).resolves.toMatchObject({
      ok: true,
      idempotent: true,
      refundStatus: "pending_provider",
    });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it("returns only the exact waitlist capability persisted in the cancellation receipt", async () => {
    const promoted = {
      ok: true,
      code: "promoted",
      salon_id: SALON_ID,
      waitlist_entry_id: "77777777-7777-4777-8777-777777777777",
      claim_capability_token: "88888888-8888-4888-8888-888888888888",
      offer_epoch: 4,
    };
    mocks.rpc.mockResolvedValue({
      data: sagaRow({
        code: "saga_replay",
        idempotent: true,
        saga_status: "refunded",
        refund_status: "succeeded",
        cancellation_result: {
          ...cancellationResult(),
          promoted_waitlist: promoted,
        },
      }),
      error: null,
    });

    await expect(cancelDeskBookingWithRefundSaga(input)).resolves.toMatchObject({
      ok: true,
      promotedWaitlist: promoted,
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("does not redispatch after provider/completion ambiguity becomes durable unknown", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: sagaRow(), error: null })
      .mockResolvedValueOnce({
        data: sagaRow({
          code: "saga_replay",
          idempotent: true,
          saga_status: "refund_unknown",
          refund_status: "unknown",
          attempt_token: null,
        }),
        error: null,
      });
    mocks.dispatch.mockResolvedValue({
      ok: false,
      status: "unknown",
      operationId: OPERATION_ID,
      reason: "completion_write_uncertain",
    });

    await expect(cancelDeskBookingWithRefundSaga(input)).resolves.toMatchObject({
      ok: true,
      refundStatus: "unknown",
    });
    await expect(cancelDeskBookingWithRefundSaga(input)).resolves.toMatchObject({
      ok: true,
      idempotent: true,
      refundStatus: "unknown",
    });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });
});
