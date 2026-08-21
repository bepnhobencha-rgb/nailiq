import { describe, expect, it } from "vitest";

import {
  parseBookingPaymentOperationMaterial,
  parseClaimedBookingPaymentOperation,
  parseClaimedPublicDepositPaymentOperation,
} from "../bookingPaymentOperations";

const salonId = "11111111-1111-4111-8111-111111111111";
const bookingId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const attemptToken = "44444444-4444-4444-8444-444444444444";
const hash = "a0b40e7d4f789b23a424f693c1b8afa3bc17e3ace629c8d0f90b8ed78f3adc59";
const base = {
  salon_id: salonId,
  booking_id: bookingId,
  operation_kind: "noshow_charge",
  provider: "square",
  provider_account_fingerprint: hash,
  amount_cents: 2_500,
  currency: "CAD",
  parent_payment_id: null,
  captured_cents: 2_500,
  refunded_cents: 0,
  reserved_cents: 0,
  remaining_refundable_cents: 0,
  material_fingerprint: "b".repeat(64),
  provider_material: {
    provider: "square",
    provider_account_id: "merchant-1",
    provider_location_id: "location-1",
    provider_environment: "sandbox",
    currency: "CAD",
    saved_card_id: "card-1",
    customer_id: "customer-1",
  },
};

describe("parseBookingPaymentOperationMaterial", () => {
  it("accepts exact charge material without coercing money", () => {
    expect(parseBookingPaymentOperationMaterial(base, "noshow_charge")).toEqual({
      salonId,
      bookingId,
      operationKind: "noshow_charge",
      provider: "square",
      providerAccountFingerprint: hash,
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
        providerAccountId: "merchant-1",
        providerLocationId: "location-1",
        providerEnvironment: "sandbox",
        currency: "CAD",
        savedCardId: "card-1",
        customerId: "customer-1",
        parentPaymentId: null,
      },
    });
  });

  it("accepts a bounded partial refund with exact remaining arithmetic", () => {
    expect(parseBookingPaymentOperationMaterial({
      ...base,
      operation_kind: "deposit_refund",
      provider: "stripe",
      provider_account_fingerprint: "1e59e91d89464f41b8479bad2bfe3128cbca2b91f536216d1104011941aa2442",
      amount_cents: 1_500,
      parent_payment_id: "pi_123",
      parent_operation_id: operationId,
      captured_cents: 5_000,
      refunded_cents: 1_000,
      reserved_cents: 500,
      remaining_refundable_cents: 3_500,
      provider_material: {
        provider: "stripe",
        provider_account_id: "acct_1",
        provider_location_id: null,
        provider_environment: null,
        currency: "CAD",
        parent_payment_id: "pi_123",
      },
    }, "deposit_refund")?.amountCents).toBe(1_500);
  });

  it("binds a late-cancel charge to the exact non-RSVP cancel occurrence", () => {
    expect(parseBookingPaymentOperationMaterial({
      ...base,
      operation_kind: "late_cancel_charge",
      operation_occurrence_version: 7,
      cancel_preview: {
        will_charge: true,
        has_chargeable_card: true,
        fee_cents: 2_500,
        currency: "CAD",
      },
      scope_kind: "booking_own",
      rsvp_semantic: null,
    }, "late_cancel_charge")?.operationOccurrenceVersion).toBe(7);
    expect(parseBookingPaymentOperationMaterial({
      ...base,
      operation_kind: "late_cancel_charge",
      operation_occurrence_version: 7,
      cancel_preview: {
        will_charge: true,
        has_chargeable_card: true,
        fee_cents: 2_500,
        currency: "CAD",
      },
      scope_kind: "member_own",
      rsvp_semantic: "decline",
    }, "late_cancel_charge")).toBeNull();
  });

  it.each([
    [{ ...base, amount_cents: "2500" }, "noshow_charge"],
    [{ ...base, provider: "paypal" }, "noshow_charge"],
    [{ ...base, material_fingerprint: "short" }, "noshow_charge"],
    [{ ...base, provider_account_fingerprint: "a".repeat(64) }, "noshow_charge"],
    [{ ...base, parent_payment_id: "pi_wrong" }, "noshow_charge"],
    [{ ...base, operation_kind: "deposit_refund", parent_payment_id: "pi_123", captured_cents: 5_000, refunded_cents: 1_000, reserved_cents: 500, remaining_refundable_cents: 3_501 }, "deposit_refund"],
    [{ ...base, operation_kind: "noshow_refund", parent_payment_id: "pi_123", amount_cents: 4_001, captured_cents: 5_000, refunded_cents: 1_000, reserved_cents: 0, remaining_refundable_cents: 4_000 }, "noshow_refund"],
  ] as const)("rejects malformed or inconsistent material %#", (value, kind) => {
    expect(parseBookingPaymentOperationMaterial(value, kind)).toBeNull();
  });

  it("accepts only an exact claimed envelope and operation-owned key", () => {
    const claimed = {
      success: true,
      code: "claimed",
      status: "sending",
      operation_id: operationId,
      attempt_token: attemptToken,
      provider_idempotency_key: `nq:${operationId}`,
      lease_expires_at: "2026-08-20T20:00:00.000Z",
      attempt_count: 1,
      material_fingerprint: base.material_fingerprint,
      material: Object.fromEntries(
        Object.entries(base).filter(([key]) => key !== "material_fingerprint"),
      ),
    };
    expect(parseClaimedBookingPaymentOperation(claimed, "noshow_charge")?.operationId)
      .toBe(operationId);
    expect(parseClaimedBookingPaymentOperation({
      ...claimed,
      provider_idempotency_key: "caller-key",
    }, "noshow_charge")).toBeNull();
  });
});

describe("parseClaimedPublicDepositPaymentOperation", () => {
  const publicAccountHash =
    "1e59e91d89464f41b8479bad2bfe3128cbca2b91f536216d1104011941aa2442";
  const publicMaterial = {
    salon_id: salonId,
    service_id: "55555555-5555-4555-8555-555555555555",
    staff_id: "66666666-6666-4666-8666-666666666666",
    start_time_utc: "2026-08-28T18:00:00.000Z",
    end_time_utc: "2026-08-28T19:00:00.000Z",
    booking_idempotency_key: "77777777-7777-4777-8777-777777777777",
    pricing_fingerprint: "c".repeat(64),
    client_phone_fingerprint: "d".repeat(64),
    operation_kind: "deposit_charge",
    provider: "stripe",
    provider_account_fingerprint: publicAccountHash,
    amount_cents: 2_000,
    currency: "CAD",
    deposit_reason: "new_customer",
    provider_material: {
      provider: "stripe",
      provider_account_id: "acct_1",
      provider_location_id: null,
      provider_application_id: null,
      provider_environment: null,
      currency: "CAD",
      amount_cents: 2_000,
      booking_intent_reference: "77777777-7777-4777-8777-777777777777",
      pricing_fingerprint: "c".repeat(64),
    },
  };

  it("accepts only the DB-bound public intent and operation-owned provider key", () => {
    const claim = {
      success: true,
      code: "claimed",
      status: "sending",
      operation_id: operationId,
      attempt_token: attemptToken,
      provider_idempotency_key: `nq:${operationId}`,
      lease_expires_at: "2026-08-20T20:00:00.000Z",
      attempt_count: 1,
      material_fingerprint: "e".repeat(64),
      material: publicMaterial,
    };
    expect(parseClaimedPublicDepositPaymentOperation(claim)?.material.amountCents)
      .toBe(2_000);
    expect(parseClaimedPublicDepositPaymentOperation({
      ...claim,
      code: "attempt_replay",
    })?.operationId).toBe(operationId);
    expect(parseClaimedPublicDepositPaymentOperation({
      ...claim,
      material: { ...publicMaterial, pricing_fingerprint: "f".repeat(64) },
    })).toBeNull();
    expect(parseClaimedPublicDepositPaymentOperation({
      ...claim,
      provider_idempotency_key: "caller-controlled",
    })).toBeNull();
  });
});
