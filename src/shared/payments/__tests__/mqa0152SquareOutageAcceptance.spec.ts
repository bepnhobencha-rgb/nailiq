import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { PaymentProvider } from "@/shared/integrations/payments";
import {
  dispatchClaimedBookingPaymentOperation,
  runAuthoritativeBookingPaymentOperation,
} from "../executeBookingPaymentOperation";
import type { ClaimedBookingPaymentOperation } from "../bookingPaymentOperations";

const salonId = "11111111-1111-4111-8111-111111111111";
const bookingId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const requestId = "55555555-5555-4555-8555-555555555555";
const materialFingerprint = "b".repeat(64);

const claim = {
  operationId,
  attemptToken: "44444444-4444-4444-8444-444444444444",
  providerIdempotencyKey: `nq:${operationId}`,
  leaseExpiresAt: "2026-08-21T20:00:00.000Z",
  attemptCount: 1,
  material: {
    salonId,
    bookingId,
    operationKind: "noshow_charge",
    provider: "square",
    providerAccountFingerprint:
      "d48a0369d1bde2c1fc42fc6df0cf7c0fe961ce8f04a698c44b61d1255bae16f3",
    amountCents: 2_500,
    currency: "CAD",
    parentPaymentId: null,
    parentOperationId: null,
    operationOccurrenceVersion: null,
    capturedCents: 2_500,
    refundedCents: 0,
    reservedCents: 0,
    remainingRefundableCents: 0,
    materialFingerprint,
    providerMaterial: {
      providerAccountId: "merchant_qa",
      providerLocationId: "location_qa",
      providerEnvironment: "sandbox",
      currency: "CAD",
      savedCardId: "card_qa",
      customerId: "customer_qa",
      parentPaymentId: null,
    },
  },
} satisfies ClaimedBookingPaymentOperation;

function squareProvider(
  chargeSavedCard: PaymentProvider["chargeSavedCard"],
): PaymentProvider {
  return {
    kind: "square",
    chargeSavedCard,
    refund: vi.fn(),
    saveCardOnFile: vi.fn(),
    removeSavedCard: vi.fn(),
    findSavedCardByPhone: vi.fn(),
  };
}

function storedMaterial() {
  return {
    salon_id: salonId,
    booking_id: bookingId,
    operation_kind: "noshow_charge",
    provider: "square",
    provider_account_fingerprint: claim.material.providerAccountFingerprint,
    amount_cents: 2_500,
    currency: "CAD",
    parent_payment_id: null,
    parent_operation_id: null,
    operation_occurrence_version: null,
    captured_cents: 2_500,
    refunded_cents: 0,
    reserved_cents: 0,
    remaining_refundable_cents: 0,
    material_fingerprint: materialFingerprint,
    provider_material: {
      provider: "square",
      provider_account_id: "merchant_qa",
      provider_location_id: "location_qa",
      provider_environment: "sandbox",
      currency: "CAD",
      saved_card_id: "card_qa",
      customer_id: "customer_qa",
      parent_payment_id: null,
    },
  };
}

describe("MQA-0152 Square API outage acceptance", () => {
  it("uses only DB-owned Square money/account/key and persists transport loss as unknown", async () => {
    const chargeSavedCard = vi.fn().mockRejectedValue(new Error("socket closed"));
    const rpc = vi.fn().mockResolvedValue({
      data: { success: false, code: "provider_outcome_unknown" },
      error: null,
    });

    const result = await dispatchClaimedBookingPaymentOperation({
      db: { rpc },
      claim,
      provider: squareProvider(chargeSavedCard),
    });

    expect(chargeSavedCard).toHaveBeenCalledTimes(1);
    expect(chargeSavedCard).toHaveBeenCalledWith(expect.objectContaining({
      customerId: "customer_qa",
      cardId: "card_qa",
      amountCents: 2_500,
      idempotencyKey: `nq:${operationId}`,
      providerAccountId: "merchant_qa",
    }));
    expect(rpc).toHaveBeenCalledWith(
      "complete_booking_payment_operation",
      expect.objectContaining({
        p_operation_id: operationId,
        p_outcome: "unknown",
        p_provider_payment_id: null,
        p_provider_refund_id: null,
        p_error_code: "provider_transport_error",
      }),
    );
    expect(result).toEqual({
      ok: false,
      status: "unknown",
      operationId,
      reason: "provider_outcome_unknown",
    });
  });

  it("ordinary replay of the durable unknown makes zero Square calls", async () => {
    const chargeSavedCard = vi.fn();
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: {
          success: true,
          code: "operation_loaded",
          status: "unknown",
          operation_id: operationId,
          salon_id: salonId,
          booking_id: bookingId,
          material_fingerprint: materialFingerprint,
          material: storedMaterial(),
          result: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          success: false,
          code: "reconcile_not_due",
          status: "unknown",
          operation_id: operationId,
        },
        error: null,
      });

    const result = await runAuthoritativeBookingPaymentOperation({
      db: { rpc },
      salonId,
      bookingId,
      requestId,
      operationKind: "noshow_charge",
      provider: squareProvider(chargeSavedCard),
      paymentAuthorization: {
        kind: "approved_no_show_fee",
        reviewId: "77777777-7777-4777-8777-777777777777",
      },
    });

    expect(chargeSavedCard).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      "claim_booking_payment_operation_reconciliation",
      {
        p_operation_id: operationId,
        p_request_id: requestId,
        p_expected_material_fingerprint: materialFingerprint,
      },
    );
    expect(result).toEqual({
      ok: false,
      status: "unknown",
      operationId,
      reason: "reconcile_not_due",
    });
  });

  it("only a granted reconciliation lease resumes the same Square operation key", async () => {
    const chargeSavedCard = vi.fn().mockResolvedValue({
      paymentId: "square_payment_qa",
      status: "COMPLETED",
    });
    const replayClaim = {
      success: true,
      code: "reconcile_claimed",
      status: "reconciling",
      operation_id: operationId,
      attempt_token: "66666666-6666-4666-8666-666666666666",
      provider_idempotency_key: `nq:${operationId}`,
      lease_expires_at: "2026-08-21T20:05:00.000Z",
      attempt_count: 2,
      material_fingerprint: materialFingerprint,
      material: storedMaterial(),
    };
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: {
          success: true,
          code: "operation_loaded",
          status: "unknown",
          operation_id: operationId,
          salon_id: salonId,
          booking_id: bookingId,
          material_fingerprint: materialFingerprint,
          material: storedMaterial(),
          result: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: replayClaim, error: null })
      .mockResolvedValueOnce({
        data: { success: true, code: "succeeded" },
        error: null,
      });

    const result = await runAuthoritativeBookingPaymentOperation({
      db: { rpc },
      salonId,
      bookingId,
      requestId,
      operationKind: "noshow_charge",
      provider: squareProvider(chargeSavedCard),
      paymentAuthorization: {
        kind: "approved_no_show_fee",
        reviewId: "77777777-7777-4777-8777-777777777777",
      },
    });

    expect(chargeSavedCard).toHaveBeenCalledTimes(1);
    expect(chargeSavedCard).toHaveBeenCalledWith(expect.objectContaining({
      amountCents: 2_500,
      providerAccountId: "merchant_qa",
      idempotencyKey: `nq:${operationId}`,
    }));
    expect(result).toEqual({
      ok: true,
      status: "succeeded",
      operationId,
      providerReceipt: "square_payment_qa",
    });
  });
});
