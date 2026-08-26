import { createHash } from "node:crypto";
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
const attemptToken = "44444444-4444-4444-8444-444444444444";
const requestId = "55555555-5555-4555-8555-555555555555";
const parentOperationId = "66666666-6666-4666-8666-666666666666";
const materialFingerprint = "b".repeat(64);
const providerAccountFingerprint = createHash("sha256")
  .update("square:merchant_qa:location_qa:sandbox", "utf8")
  .digest("hex");

function refundClaim(amountCents = 1_500): ClaimedBookingPaymentOperation {
  return {
    operationId,
    attemptToken,
    providerIdempotencyKey: `nq:${operationId}`,
    leaseExpiresAt: "2026-08-23T20:00:00.000Z",
    attemptCount: 1,
    material: {
      salonId,
      bookingId,
      operationKind: "deposit_refund",
      provider: "square",
      providerAccountFingerprint,
      amountCents,
      currency: "CAD",
      parentPaymentId: "square_payment_qa",
      parentOperationId,
      operationOccurrenceVersion: null,
      capturedCents: 5_000,
      refundedCents: 1_000,
      reservedCents: 500,
      remainingRefundableCents: 3_500,
      materialFingerprint,
      providerMaterial: {
        providerAccountId: "merchant_qa",
        providerLocationId: "location_qa",
        providerEnvironment: "sandbox",
        currency: "CAD",
        savedCardId: null,
        customerId: null,
        parentPaymentId: "square_payment_qa",
      },
    },
  };
}

function storedMaterial(amountCents = 1_500) {
  const claim = refundClaim(amountCents);
  return {
    salon_id: claim.material.salonId,
    booking_id: claim.material.bookingId,
    operation_kind: claim.material.operationKind,
    provider: claim.material.provider,
    provider_account_fingerprint: claim.material.providerAccountFingerprint,
    amount_cents: claim.material.amountCents,
    currency: claim.material.currency,
    parent_payment_id: claim.material.parentPaymentId,
    parent_operation_id: claim.material.parentOperationId,
    operation_occurrence_version: null,
    captured_cents: claim.material.capturedCents,
    refunded_cents: claim.material.refundedCents,
    reserved_cents: claim.material.reservedCents,
    remaining_refundable_cents: claim.material.remainingRefundableCents,
    material_fingerprint: claim.material.materialFingerprint,
    provider_material: {
      provider_account_id: claim.material.providerMaterial.providerAccountId,
      provider_location_id: claim.material.providerMaterial.providerLocationId,
      provider_environment: claim.material.providerMaterial.providerEnvironment,
      currency: claim.material.providerMaterial.currency,
      saved_card_id: null,
      customer_id: null,
      parent_payment_id: claim.material.providerMaterial.parentPaymentId,
    },
  };
}

function squareProvider(refund: PaymentProvider["refund"]): PaymentProvider {
  return {
    kind: "square",
    refund,
    chargeSavedCard: vi.fn(),
    saveCardOnFile: vi.fn(),
    removeSavedCard: vi.fn(),
    findSavedCardByPhone: vi.fn(),
  };
}

function completedRpc(code = "succeeded") {
  return vi.fn().mockResolvedValue({
    data: { success: code === "succeeded", code },
    error: null,
  });
}

describe("MQA-0126 fake Square refund matrix", () => {
  it.each([
    ["partial", 1_500],
    ["full remaining", 3_500],
  ])("dispatches an exact %s CAD refund from DB-owned material", async (_label, amountCents) => {
    const refund = vi.fn().mockResolvedValue({
      refundId: `square_refund_${amountCents}`,
      status: "COMPLETED",
    });
    const rpc = completedRpc();

    const result = await dispatchClaimedBookingPaymentOperation({
      db: { rpc },
      claim: refundClaim(amountCents),
      provider: squareProvider(refund),
      reason: "Booking cancelled - QA fake refund",
    });

    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith({
      paymentId: "square_payment_qa",
      amountCents,
      reason: "Booking cancelled - QA fake refund",
      idempotencyKey: `nq:${operationId}`,
      providerAccountId: "merchant_qa",
      providerLocationId: "location_qa",
      providerEnvironment: "sandbox",
      providerCurrency: "CAD",
      providerAccountFingerprint,
    });
    expect(rpc).toHaveBeenCalledWith(
      "complete_booking_payment_operation",
      expect.objectContaining({
        p_operation_id: operationId,
        p_attempt_token: attemptToken,
        p_outcome: "succeeded",
        p_provider_status: "COMPLETED",
        p_provider_payment_id: null,
        p_provider_refund_id: `square_refund_${amountCents}`,
      }),
    );
    expect(result).toEqual({
      ok: true,
      status: "succeeded",
      operationId,
      providerReceipt: `square_refund_${amountCents}`,
    });
  });

  it.each([
    ["PENDING", "pending_provider", "pending_provider", null],
    ["FAILED", "definite_failure", "definite_failure", "provider_rejected"],
    ["MYSTERY", "unknown", "provider_outcome_unknown", "provider_outcome_ambiguous"],
  ] as const)(
    "maps Square %s without inventing refund success",
    async (providerStatus, expectedOutcome, dbCode, errorCode) => {
      const refund = vi.fn().mockResolvedValue({
        refundId: "square_refund_status",
        status: providerStatus,
      });
      const rpc = vi.fn().mockResolvedValue({
        data: { success: expectedOutcome === "pending_provider", code: dbCode },
        error: null,
      });

      const result = await dispatchClaimedBookingPaymentOperation({
        db: { rpc },
        claim: refundClaim(),
        provider: squareProvider(refund),
      });

      expect(refund).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith(
        "complete_booking_payment_operation",
        expect.objectContaining({
          p_outcome: expectedOutcome,
          p_provider_status: providerStatus,
          p_provider_refund_id: expectedOutcome === "definite_failure"
            ? null
            : "square_refund_status",
          p_error_code: errorCode,
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        status: expectedOutcome,
        operationId,
        reason: dbCode,
      });
    },
  );

  it("persists response loss as unknown and calls Square only once", async () => {
    const refund = vi.fn().mockRejectedValue(new Error("socket closed"));
    const rpc = vi.fn().mockResolvedValue({
      data: { success: false, code: "provider_outcome_unknown" },
      error: null,
    });

    const result = await dispatchClaimedBookingPaymentOperation({
      db: { rpc },
      claim: refundClaim(),
      provider: squareProvider(refund),
    });

    expect(refund).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "complete_booking_payment_operation",
      expect.objectContaining({
        p_outcome: "unknown",
        p_provider_refund_id: null,
        p_error_code: "provider_transport_error",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      status: "unknown",
      reason: "provider_outcome_unknown",
    });
  });

  it("never reports refund success when the DB completion write is uncertain", async () => {
    const refund = vi.fn().mockResolvedValue({
      refundId: "square_refund_committed",
      status: "COMPLETED",
    });

    const result = await dispatchClaimedBookingPaymentOperation({
      db: {
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { message: "db unavailable" },
        }),
      },
      claim: refundClaim(),
      provider: squareProvider(refund),
    });

    expect(refund).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: false,
      status: "unknown",
      operationId,
      reason: "completion_write_uncertain",
    });
  });

  it("replays a stored refund receipt without a second Square call", async () => {
    const refund = vi.fn();
    const rpc = vi.fn().mockResolvedValueOnce({
      data: {
        success: true,
        code: "operation_loaded",
        status: "succeeded",
        operation_id: operationId,
        salon_id: salonId,
        booking_id: bookingId,
        material_fingerprint: materialFingerprint,
        material: storedMaterial(),
        result: { provider_refund_id: "square_refund_stored" },
      },
      error: null,
    });

    const result = await runAuthoritativeBookingPaymentOperation({
      db: { rpc },
      salonId,
      bookingId,
      requestId,
      operationKind: "deposit_refund",
      provider: squareProvider(refund),
    });

    expect(refund).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      status: "succeeded",
      operationId,
      providerReceipt: "square_refund_stored",
    });
  });

  it("rejects a reused refund request id when the caller changes the amount", async () => {
    const refund = vi.fn();
    const rpc = vi.fn().mockResolvedValueOnce({
      data: {
        success: true,
        code: "operation_loaded",
        status: "succeeded",
        operation_id: operationId,
        salon_id: salonId,
        booking_id: bookingId,
        material_fingerprint: materialFingerprint,
        material: storedMaterial(1_500),
        result: { provider_refund_id: "square_refund_stored" },
      },
      error: null,
    });

    const result = await runAuthoritativeBookingPaymentOperation({
      db: { rpc },
      salonId,
      bookingId,
      requestId,
      operationKind: "deposit_refund",
      amountCents: 2_000,
      provider: squareProvider(refund),
    });

    expect(refund).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: false,
      status: "not_claimed",
      operationId,
      reason: "payment_replay_material_conflict",
    });
  });

  it("redispatches only after a due reconciliation lease and reuses the exact refund key", async () => {
    const refund = vi.fn().mockResolvedValue({
      refundId: "square_refund_reconciled",
      status: "COMPLETED",
    });
    const material = storedMaterial();
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
          material,
          result: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          code: "reconcile_claimed",
          status: "reconciling",
          operation_id: operationId,
          attempt_token: "77777777-7777-4777-8777-777777777777",
          provider_idempotency_key: `nq:${operationId}`,
          lease_expires_at: "2026-08-23T20:05:00.000Z",
          attempt_count: 2,
          material_fingerprint: materialFingerprint,
          material,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { success: true, code: "succeeded" },
        error: null,
      });

    const result = await runAuthoritativeBookingPaymentOperation({
      db: { rpc },
      salonId,
      bookingId,
      requestId,
      operationKind: "deposit_refund",
      provider: squareProvider(refund),
    });

    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith(expect.objectContaining({
      paymentId: "square_payment_qa",
      amountCents: 1_500,
      idempotencyKey: `nq:${operationId}`,
      providerAccountId: "merchant_qa",
      providerLocationId: "location_qa",
      providerEnvironment: "sandbox",
      providerCurrency: "CAD",
      providerAccountFingerprint,
    }));
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
      ok: true,
      status: "succeeded",
      operationId,
      providerReceipt: "square_refund_reconciled",
    });
  });

  it("rejects mismatched DB/provider currency material before a Square call", async () => {
    const refund = vi.fn();
    const invalidMaterial = storedMaterial();
    invalidMaterial.provider_material.currency = "USD";
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: { success: false, code: "operation_not_found" },
        error: null,
      })
      .mockResolvedValueOnce({ data: invalidMaterial, error: null });

    const result = await runAuthoritativeBookingPaymentOperation({
      db: { rpc },
      salonId,
      bookingId,
      requestId,
      operationKind: "deposit_refund",
      amountCents: 1_500,
      provider: squareProvider(refund),
    });

    expect(refund).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      ok: false,
      status: "not_claimed",
      operationId: null,
      reason: "payment_material_invalid",
    });
  });
});
