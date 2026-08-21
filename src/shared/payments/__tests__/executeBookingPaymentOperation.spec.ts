import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  dispatchClaimedBookingPaymentOperation,
  runAuthoritativeBookingPaymentOperation,
} from "../executeBookingPaymentOperation";
import type { ClaimedBookingPaymentOperation } from "../bookingPaymentOperations";

const operationId = "33333333-3333-4333-8333-333333333333";
const claim = {
  operationId,
  attemptToken: "44444444-4444-4444-8444-444444444444",
  providerIdempotencyKey: `nq:${operationId}`,
  leaseExpiresAt: "2026-08-20T20:00:00.000Z",
  attemptCount: 1,
  material: {
    salonId: "11111111-1111-4111-8111-111111111111",
    bookingId: "22222222-2222-4222-8222-222222222222",
    operationKind: "noshow_charge",
    provider: "stripe",
    providerAccountFingerprint: "1e59e91d89464f41b8479bad2bfe3128cbca2b91f536216d1104011941aa2442",
    amountCents: 2_500,
    currency: "CAD",
    parentPaymentId: null,
    parentOperationId: null,
    operationOccurrenceVersion: null,
    capturedCents: 2_500,
    refundedCents: 0,
    reservedCents: 0,
    remainingRefundableCents: 0,
    materialFingerprint: "b".repeat(64),
    providerMaterial: {
      providerAccountId: "acct_1",
      providerLocationId: null,
      providerEnvironment: null,
      currency: "CAD",
      savedCardId: "pm_1",
      customerId: "cus_1",
      parentPaymentId: null,
    },
  },
} satisfies ClaimedBookingPaymentOperation;

function provider(overrides: Record<string, unknown> = {}) {
  return {
    kind: "stripe" as const,
    chargeSavedCard: vi.fn().mockResolvedValue({ paymentId: "pi_123456", status: "succeeded" }),
    refund: vi.fn(),
    saveCardOnFile: vi.fn(),
    removeSavedCard: vi.fn(),
    findSavedCardByPhone: vi.fn(),
    ...overrides,
  };
}

describe("dispatchClaimedBookingPaymentOperation", () => {
  it("uses only the operation-owned provider key/account and completes a final receipt", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { success: true, code: "succeeded" },
      error: null,
    });
    const paymentProvider = provider();
    const result = await dispatchClaimedBookingPaymentOperation({
      db: { rpc },
      claim,
      provider: paymentProvider,
    });
    expect(paymentProvider.chargeSavedCard).toHaveBeenCalledWith(expect.objectContaining({
      amountCents: 2_500,
      idempotencyKey: `nq:${operationId}`,
      providerAccountId: "acct_1",
    }));
    expect(rpc).toHaveBeenCalledWith("complete_booking_payment_operation", expect.objectContaining({
      p_outcome: "succeeded",
      p_provider_payment_id: "pi_123456",
    }));
    expect(result.ok).toBe(true);
  });

  it("marks a thrown/response-loss provider call unknown and never calls it twice", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { success: false, code: "provider_outcome_unknown" },
      error: null,
    });
    const paymentProvider = provider({
      chargeSavedCard: vi.fn().mockRejectedValue(new Error("socket closed")),
    });
    const result = await dispatchClaimedBookingPaymentOperation({
      db: { rpc },
      claim,
      provider: paymentProvider,
    });
    expect(paymentProvider.chargeSavedCard).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("complete_booking_payment_operation", expect.objectContaining({
      p_outcome: "unknown",
      p_error_code: "provider_transport_error",
    }));
    expect(result).toMatchObject({ ok: false, status: "unknown" });
  });

  it("never reports success when the provider receipt committed but DB completion was lost", async () => {
    const result = await dispatchClaimedBookingPaymentOperation({
      db: { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "db unavailable" } }) },
      claim,
      provider: provider(),
    });
    expect(result).toMatchObject({
      ok: false,
      status: "unknown",
      reason: "completion_write_uncertain",
    });
  });

  it("does not redispatch an unknown operation on ordinary replay", async () => {
    const paymentProvider = provider();
    const material = {
      salon_id: claim.material.salonId,
      booking_id: claim.material.bookingId,
      operation_kind: "noshow_charge",
      provider: "stripe",
      provider_account_fingerprint:
        "1e59e91d89464f41b8479bad2bfe3128cbca2b91f536216d1104011941aa2442",
      amount_cents: 2_500,
      currency: "CAD",
      parent_payment_id: null,
      parent_operation_id: null,
      operation_occurrence_version: null,
      captured_cents: 2_500,
      refunded_cents: 0,
      reserved_cents: 0,
      remaining_refundable_cents: 0,
      material_fingerprint: "b".repeat(64),
      provider_material: {
        provider_account_id: "acct_1",
        provider_location_id: null,
        provider_environment: null,
        currency: "CAD",
        saved_card_id: "pm_1",
        customer_id: "cus_1",
        parent_payment_id: null,
      },
    };
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: {
          success: true,
          code: "operation_loaded",
          status: "unknown",
          operation_id: operationId,
          salon_id: claim.material.salonId,
          booking_id: claim.material.bookingId,
          material_fingerprint: material.material_fingerprint,
          material,
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
      salonId: claim.material.salonId,
      bookingId: claim.material.bookingId!,
      requestId: "55555555-5555-4555-8555-555555555555",
      operationKind: "noshow_charge",
      provider: paymentProvider,
    });
    expect(result).toMatchObject({
      ok: false,
      status: "unknown",
      operationId,
      reason: "reconcile_not_due",
    });
    expect(paymentProvider.chargeSavedCard).not.toHaveBeenCalled();
  });
});
