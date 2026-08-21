import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { dispatchClaimedBookingPaymentOperation } from "../executeBookingPaymentOperation";
import { stableBookingPaymentRequestId } from "../paymentRequestId";
import type { ClaimedBookingPaymentOperation } from "../bookingPaymentOperations";

const root = process.cwd();
const migration = readFileSync(
  resolve(root, "supabase/migrations/20260820150000_add_authoritative_booking_payment_operations.sql"),
  "utf8",
);
const cancelRoute = readFileSync(
  resolve(root, "src/app/api/booking/cancel-action/route.ts"),
  "utf8",
);
const legacyNoShow = readFileSync(
  resolve(root, "src/shared/integrations/square/noshow.ts"),
  "utf8",
);
const paymentParser = readFileSync(
  resolve(root, "src/shared/payments/bookingPaymentOperations.ts"),
  "utf8",
);
const paymentExecutor = readFileSync(
  resolve(root, "src/shared/payments/executeBookingPaymentOperation.ts"),
  "utf8",
);
const cancelRuntime = `${cancelRoute}\n${paymentExecutor}`;

function requirePattern(source: string, pattern: RegExp, message: string) {
  expect(source, message).toMatch(pattern);
}

function forbidPattern(source: string, pattern: RegExp, message: string) {
  expect(source, message).not.toMatch(pattern);
}

function sqlFunction(name: string) {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const start = migration.indexOf(marker);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  const end = migration.indexOf("$function$;", start);
  expect(end, `${name} body must terminate`).toBeGreaterThan(start);
  return migration.slice(start, end + "$function$;".length);
}

describe("late-cancellation authoritative payment acceptance", () => {
  it("uses dedicated late-cancel charge/refund kinds rather than no-show financial semantics", () => {
    requirePattern(migration, /'late_cancel_charge'/, "ledger must model late-cancel charge separately");
    requirePattern(migration, /'late_cancel_refund'/, "ledger must model late-cancel refund separately");
    requirePattern(paymentParser, /late_cancel_charge/, "strict app parser must recognize the locked charge kind");
    requirePattern(paymentParser, /late_cancel_refund/, "strict app parser must recognize the locked refund kind");
    requirePattern(cancelRoute, /operationKind:\s*"late_cancel_charge"/, "customer cancellation must explicitly select the dedicated ledger kind");
    forbidPattern(cancelRoute, /operationKind:\s*"noshow_charge"/, "customer cancellation must never select no-show financial identity");
  });

  it("binds charge material to the exact persisted cancel occurrence and policy preview", () => {
    requirePattern(migration, /late_cancel_charge[\s\S]*?(?:transition_version|action_epoch|occurrence)/i, "charge material must bind the exact cancel transition occurrence");
    requirePattern(migration, /late_cancel_charge[\s\S]*?(?:cancel_preview|fee_cents|policy)/i, "charge material must bind the committed policy/fee snapshot");
    requirePattern(cancelRoute, /transitionVersion|actionEpoch/, "route must pass the DB-owned cancel occurrence, not derive it from browser time");
    requirePattern(cancelRoute, /const preview = committed\.cancelPreview[\s\S]{0,1200}?amountCentsOverride:\s*preview\.feeCents[\s\S]{0,180}?operationKind:\s*"late_cancel_charge"[\s\S]{0,180}?occurrenceVersion:\s*committed\.transitionVersion/, "route must pass the committed fee snapshot and occurrence into the dedicated path");
    requirePattern(paymentExecutor, /load_booking_payment_operation_material[\s\S]{0,600}?parseBookingPaymentOperationMaterial[\s\S]{0,600}?claim_booking_payment_operation[\s\S]{0,300}?p_expected_material_fingerprint:\s*material\.materialFingerprint/, "runtime must load then claim the exact DB-owned occurrence and preview fingerprint");
  });

  it("keeps RSVP member/organizer decline as attendance-only with zero provider work", () => {
    requirePattern(cancelRoute, /let feeCents\s*=\s*0[\s\S]{0,180}?if \(!isRsvpDecline/, "RSVP decline must retain the zero-charge default and skip dispatch");
    requirePattern(cancelRoute, /if \(!isRsvpDecline[\s\S]{0,300}?willCharge/, "provider dispatch must be unreachable for RSVP decline");
    requirePattern(cancelRoute, /fee_decision:[\s\S]{0,120}?rsvp_no_charge/, "audit must preserve explicit no-charge semantics");
  });

  it("replays response loss with one provider attempt and never rotates an unknown key", () => {
    requirePattern(cancelRuntime, /claim_booking_payment_operation/, "runtime must durably claim before late-cancel provider dispatch");
    requirePattern(cancelRuntime, /complete_booking_payment_operation/, "runtime must persist accepted/failed/unknown provider truth");
    requirePattern(cancelRuntime, /operation_replay/, "exact response-loss replay must return the existing terminal result");
    requirePattern(cancelRuntime, /reconciliation_required/, "unknown provider outcome must not be blindly retried");
    requirePattern(migration, /provider_idempotency_key[\s\S]{0,180}'nq:'\|\|v_id::text/, "late-cancel provider identity must derive from the durable operation id");
    forbidPattern(cancelRuntime, /idempotencySuffix|randomUUID\(\)[\s\S]{0,120}?(?:charge|provider)/, "retry must never rotate provider identity");
  });

  it("records a late-cancel provider response loss as unknown after exactly one attempt", async () => {
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
        operationKind: "late_cancel_charge",
        provider: "stripe",
        providerAccountFingerprint: "a".repeat(64),
        amountCents: 2_500,
        currency: "CAD",
        parentPaymentId: null,
        parentOperationId: null,
        operationOccurrenceVersion: 7,
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
    const chargeSavedCard = vi.fn().mockRejectedValue(new Error("socket closed"));
    const rpc = vi.fn().mockResolvedValue({
      data: { success: false, code: "provider_outcome_unknown" },
      error: null,
    });

    const result = await dispatchClaimedBookingPaymentOperation({
      db: { rpc },
      claim,
      provider: {
        kind: "stripe",
        chargeSavedCard,
        refund: vi.fn(),
        saveCardOnFile: vi.fn(),
        removeSavedCard: vi.fn(),
        findSavedCardByPhone: vi.fn(),
      },
    });

    expect(chargeSavedCard).toHaveBeenCalledTimes(1);
    expect(chargeSavedCard).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `nq:${operationId}`,
      amountCents: 2_500,
    }));
    expect(rpc).toHaveBeenCalledWith("complete_booking_payment_operation", expect.objectContaining({
      p_outcome: "unknown",
      p_error_code: "provider_transport_error",
    }));
    expect(result).toMatchObject({ ok: false, status: "unknown" });
  });

  it("creates a new occurrence after undo then cancel while exact retry still dedupes", () => {
    requirePattern(cancelRoute, /transitionVersion|actionEpoch/, "operation material must use the persisted transition occurrence");
    forbidPattern(cancelRoute, /(?:late.?cancel|cancel):\$?\{?committed\.bookingId\}?["'`]?\s*[,;}]/i, "booking id alone cannot identify repeated cancel transitions");
    requirePattern(migration, /request_id[\s\S]{0,160}?operation_kind[\s\S]{0,300}?(?:transition_version|occurrence|action_epoch)/i, "ledger uniqueness/material must distinguish undo then re-cancel from exact retry");

    const bookingId = "22222222-2222-4222-8222-222222222222";
    const firstCancel = stableBookingPaymentRequestId(bookingId, "late_cancel_charge", "7");
    expect(stableBookingPaymentRequestId(bookingId, "late_cancel_charge", "7"))
      .toBe(firstCancel);
    expect(stableBookingPaymentRequestId(bookingId, "late_cancel_charge", "9"))
      .not.toBe(firstCancel);
    expect(stableBookingPaymentRequestId(bookingId, "noshow_charge", "7"))
      .not.toBe(firstCancel);
  });

  it("refunds only the exact late-cancel parent and makes Fair Cancel response-loss safe", () => {
    const load = sqlFunction("load_late_cancel_refund_material");
    const claim = sqlFunction("claim_late_cancel_refund");
    requirePattern(load, /operation_kind='late_cancel_charge'/, "refund parent must be a late-cancel charge, never a no-show charge");
    requirePattern(load, /parent_operation_id[\s\S]{0,500}?late_cancel_refund|late_cancel_refund[\s\S]{0,500}?parent_operation_id/, "late-cancel refund must bind its exact charge operation");
    requirePattern(claim, /load_late_cancel_refund_material/, "claim must reuse the dedicated authoritative parent resolver");
    requirePattern(legacyNoShow, /runAuthoritativeLateCancelRefund\(\{/, "Fair Cancel must delegate to the dedicated authoritative refund helper");
    requirePattern(paymentExecutor, /export async function runAuthoritativeLateCancelRefund[\s\S]{0,2500}?load_late_cancel_refund_material[\s\S]{0,2500}?claim_late_cancel_refund[\s\S]{0,1500}?dispatchClaimedBookingPaymentOperation/, "dedicated helper must load, claim, then dispatch only DB-owned refund material");
    requirePattern(`${legacyNoShow}\n${paymentExecutor}`, /complete_booking_payment_operation/, "Fair Cancel provider outcome must be durable and replayable");
    forbidPattern(legacyNoShow, /refundNoShowFee\(c\.id/, "Fair Cancel must not use the legacy no-show refund path");
  });

  it("rejects late-cancel refunds at the generic claim boundary before insert", () => {
    const claimGeneric = sqlFunction("claim_booking_payment_operation");
    requirePattern(claimGeneric, /p_operation_kind='late_cancel_refund'[\s\S]{0,180}?'dedicated_late_cancel_refund_required'/, "generic claim must reject the dedicated parent-bound refund kind");
    expect(claimGeneric.indexOf("dedicated_late_cancel_refund_required"), "denial must occur before any ledger insert")
      .toBeLessThan(claimGeneric.indexOf("INSERT INTO public.booking_payment_operations"));
  });
});
