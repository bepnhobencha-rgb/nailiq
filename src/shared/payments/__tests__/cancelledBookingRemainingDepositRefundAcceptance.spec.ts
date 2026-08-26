import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { PaymentProvider } from "@/shared/integrations/payments";
import { runCancelledBookingRemainingDepositRefund } from "../executeBookingPaymentOperation";

const root = process.cwd();
const migration = readFileSync(
  resolve(
    root,
    "supabase/migrations/20260823171226_claim_cancelled_booking_remaining_deposit_refund.sql",
  ),
  "utf8",
);
const paymentExecutor = readFileSync(
  resolve(root, "src/shared/payments/executeBookingPaymentOperation.ts"),
  "utf8",
);

const salonId = "11111111-1111-4111-8111-111111111111";
const bookingId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const attemptToken = "44444444-4444-4444-8444-444444444444";
const requestId = "55555555-5555-4555-8555-555555555555";
const parentOperationId = "66666666-6666-4666-8666-666666666666";
const materialFingerprint = "b".repeat(64);
const expectedRemainingCents = 3_000;
const providerAccountFingerprint = createHash("sha256")
  .update("square:merchant_qa:location_qa:sandbox", "utf8")
  .digest("hex");

function indexOfPattern(source: string, pattern: RegExp, label: string) {
  const match = pattern.exec(source);
  expect(match, label).not.toBeNull();
  return match?.index ?? -1;
}

function claimedRemainingRefund() {
  return {
    success: true,
    code: "claimed",
    status: "sending",
    operation_id: operationId,
    attempt_token: attemptToken,
    provider_idempotency_key: `nq:${operationId}`,
    lease_expires_at: "2026-08-23T22:00:00.000Z",
    attempt_count: 1,
    material_fingerprint: materialFingerprint,
    material: {
      salon_id: salonId,
      booking_id: bookingId,
      operation_kind: "deposit_refund",
      provider: "square",
      provider_account_fingerprint: providerAccountFingerprint,
      amount_cents: expectedRemainingCents,
      currency: "CAD",
      parent_payment_id: "square_payment_qa",
      parent_operation_id: parentOperationId,
      operation_occurrence_version: null,
      captured_cents: 5_000,
      refunded_cents: 2_000,
      reserved_cents: 0,
      remaining_refundable_cents: expectedRemainingCents,
      provider_material: {
        provider_account_id: "merchant_qa",
        provider_location_id: "location_qa",
        provider_environment: "sandbox",
        currency: "CAD",
        saved_card_id: null,
        customer_id: null,
        parent_payment_id: "square_payment_qa",
      },
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

describe("cancelled booking remaining-deposit refund acceptance", () => {
  it("keeps the SECURITY DEFINER claim RPC service-role only", () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.claim_cancelled_booking_remaining_deposit_refund\([\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path TO ''/,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.claim_cancelled_booking_remaining_deposit_refund\([\s\S]*?\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.claim_cancelled_booking_remaining_deposit_refund\([\s\S]*?\) TO service_role;/,
    );
  });

  it("checks stable-request replay before locking and checking mutable booking status", () => {
    const replayLookup = indexOfPattern(
      migration,
      /FROM public\.booking_payment_operations\s+WHERE salon_id=p_salon_id\s+AND request_id=p_request_id\s+AND operation_kind='deposit_refund'\s+FOR UPDATE;/,
      "the dedicated RPC must lock and inspect the stable logical request",
    );
    const replayReturn = indexOfPattern(
      migration,
      /RETURN public\.claim_booking_payment_operation\(\s*p_salon_id,\s*p_booking_id,\s*p_request_id,\s*'deposit_refund',\s*v_existing\.amount_cents,\s*v_existing\.material_fingerprint\s*\);/,
      "a matching request must replay through the authoritative claim RPC",
    );
    const bookingLock = indexOfPattern(
      migration,
      /FROM public\.bookings\s+WHERE id=p_booking_id AND salon_id=p_salon_id\s+FOR UPDATE;/,
      "the tenant-bound booking row must be locked before mutable refund arithmetic",
    );
    const cancelledGuard = indexOfPattern(
      migration,
      /IF v_booking\.status <> 'cancelled' THEN\s+RETURN jsonb_build_object\('success',false,'code','booking_not_cancelled'\);/,
      "only a still-cancelled booking may claim the remaining refund",
    );

    expect(replayLookup).toBeLessThan(replayReturn);
    expect(replayReturn).toBeLessThan(bookingLock);
    expect(bookingLock).toBeLessThan(cancelledGuard);
  });

  it("requires zero unresolved reservation and the exact locked remaining amount", () => {
    expect(migration).toMatch(
      /operation_kind='deposit_refund'\s+AND o\.status IN \('sending','pending_provider','reconciling','unknown'\)/,
    );
    expect(migration).toMatch(
      /v_remaining := greatest\(\s*0,\s*v_parent\.amount_cents\s*- coalesce\(v_booking\.deposit_refunded_cents,0\)\s*- v_reserved\s*\);/,
    );

    const reservedGuard = indexOfPattern(
      migration,
      /IF v_reserved > 0 THEN[\s\S]*?'code','refund_reconciliation_required'/,
      "an unresolved refund reservation must fail closed",
    );
    const exactRemainingGuard = indexOfPattern(
      migration,
      /IF p_expected_remaining_cents <> v_remaining THEN[\s\S]*?'code','refund_remaining_changed'/,
      "the confirmed amount must equal the remaining amount under lock",
    );
    expect(reservedGuard).toBeLessThan(exactRemainingGuard);
  });

  it("resolves canonical provider material and claims only its fingerprint", () => {
    expect(migration).toMatch(
      /v_loaded := public\.resolve_booking_payment_operation_material\(\s*p_salon_id,\s*p_booking_id,\s*'deposit_refund',\s*v_remaining,\s*true,\s*NULL\s*\);/,
    );
    expect(migration).toMatch(
      /RETURN public\.claim_booking_payment_operation\(\s*p_salon_id,\s*p_booking_id,\s*p_request_id,\s*'deposit_refund',\s*v_remaining,\s*v_loaded->>'material_fingerprint'\s*\);/,
    );
  });

  it("keeps a dedicated runner wired to the exact expected amount and deposit-refund parser", () => {
    const runnerStart = paymentExecutor.indexOf(
      "export async function runCancelledBookingRemainingDepositRefund",
    );
    expect(runnerStart).toBeGreaterThanOrEqual(0);
    const runnerEnd = paymentExecutor.indexOf(
      "/** Dedicated parent-bound Fair Cancel refund.",
      runnerStart,
    );
    expect(runnerEnd).toBeGreaterThan(runnerStart);
    const runner = paymentExecutor.slice(runnerStart, runnerEnd);

    expect(runner).toMatch(
      /args\.db\.rpc\(\s*"claim_cancelled_booking_remaining_deposit_refund",\s*\{[\s\S]*?p_expected_remaining_cents: args\.expectedRemainingCents/,
    );
    expect(runner).toMatch(
      /parseClaimedBookingPaymentOperation\(\s*claimed\.data,\s*"deposit_refund"/,
    );
    expect(runner).toMatch(
      /code === "operation_replay"[\s\S]*?provider_refund_id/,
    );
  });

  it("dispatches the exact DB-claimed remaining amount and persists its receipt", async () => {
    const refund = vi.fn().mockResolvedValue({
      refundId: "square_refund_remaining",
      status: "COMPLETED",
    });
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: claimedRemainingRefund(), error: null })
      .mockResolvedValueOnce({
        data: { success: true, code: "succeeded" },
        error: null,
      });

    const result = await runCancelledBookingRemainingDepositRefund({
      db: { rpc },
      salonId,
      bookingId,
      requestId,
      expectedRemainingCents,
      provider: squareProvider(refund),
    });

    expect(rpc).toHaveBeenNthCalledWith(
      1,
      "claim_cancelled_booking_remaining_deposit_refund",
      {
        p_salon_id: salonId,
        p_booking_id: bookingId,
        p_request_id: requestId,
        p_expected_remaining_cents: expectedRemainingCents,
      },
    );
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith(expect.objectContaining({
      paymentId: "square_payment_qa",
      amountCents: expectedRemainingCents,
      idempotencyKey: `nq:${operationId}`,
      providerAccountId: "merchant_qa",
      providerLocationId: "location_qa",
      providerEnvironment: "sandbox",
      providerCurrency: "CAD",
      providerAccountFingerprint,
    }));
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      "complete_booking_payment_operation",
      expect.objectContaining({
        p_operation_id: operationId,
        p_attempt_token: attemptToken,
        p_outcome: "succeeded",
        p_provider_refund_id: "square_refund_remaining",
      }),
    );
    expect(result).toEqual({
      ok: true,
      status: "succeeded",
      operationId,
      providerReceipt: "square_refund_remaining",
    });
  });

  it("replays the stored receipt without a second provider refund", async () => {
    const refund = vi.fn();
    const rpc = vi.fn().mockResolvedValue({
      data: {
        success: true,
        code: "operation_replay",
        status: "succeeded",
        operation_id: operationId,
        result: { provider_refund_id: "square_refund_stored" },
      },
      error: null,
    });

    const result = await runCancelledBookingRemainingDepositRefund({
      db: { rpc },
      salonId,
      bookingId,
      requestId,
      expectedRemainingCents,
      provider: squareProvider(refund),
    });

    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith(
      "claim_cancelled_booking_remaining_deposit_refund",
      expect.objectContaining({
        p_request_id: requestId,
        p_expected_remaining_cents: expectedRemainingCents,
      }),
    );
    expect(refund).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      status: "succeeded",
      operationId,
      providerReceipt: "square_refund_stored",
    });
  });

  it("surfaces a changed remaining amount without dispatching the provider", async () => {
    const refund = vi.fn();
    const rpc = vi.fn().mockResolvedValue({
      data: {
        success: false,
        code: "refund_remaining_changed",
        remaining_refundable_cents: 2_500,
      },
      error: null,
    });

    const result = await runCancelledBookingRemainingDepositRefund({
      db: { rpc },
      salonId,
      bookingId,
      requestId,
      expectedRemainingCents,
      provider: squareProvider(refund),
    });

    expect(refund).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledOnce();
    expect(result).toEqual({
      ok: false,
      status: "not_claimed",
      operationId: null,
      reason: "refund_remaining_changed",
    });
  });
});
