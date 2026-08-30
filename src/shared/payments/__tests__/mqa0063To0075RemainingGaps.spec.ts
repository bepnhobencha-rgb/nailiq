import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const voiceExecutor = read("src/shared/voiceai/toolExecutor.ts");
const receptionistActions = read("src/shared/dashboard/receptionistActions.ts");
const receptionistCenter = read("src/components/receptionist/ReceptionistCenter.tsx");
const deskCancelRefundSaga = read("src/shared/payments/deskCancelRefundSaga.ts");
const deskDeposits = read("src/shared/integrations/square/deposits.ts");
const paymentExecutor = read("src/shared/payments/executeBookingPaymentOperation.ts");
const publicDepositRoute = read("src/app/api/booking/deposit-intent/route.ts");
const publicDepositPanel = read("src/components/booking/BookingFlowDepositPanel.tsx");
const paymentMigration = read(
  "supabase/migrations/20260820150000_add_authoritative_booking_payment_operations.sql",
);
const cancelRefundMaterialRepair = read(
  "supabase/migrations/20260823164000_return_claimed_material_from_cancel_refund_saga.sql",
);

describe("MQA-0063..0075 remaining Sellable-V1 payment gaps", () => {
  it("Voice cancellation consumes a canonical occurrence but never dispatches the reviewable fee", () => {
    expect(voiceExecutor).toMatch(/late_fee_confirmation_required/);
    expect(voiceExecutor).toMatch(/validateLateFeeChallenge\(/);
    expect(voiceExecutor).toMatch(/isExplicitFeeAcknowledgement\(input\.currentUtterance\)/);
    expect(voiceExecutor).toMatch(/feeStatus = chargeableCommitted \? "approval_required"/);

    expect.soft(
      voiceExecutor,
      "verified Voice cancellation must consume the canonical cancel capability/RPC, not update booking status directly",
    ).toMatch(/cancelBookingWithManagementCapability|cancel_booking_with_management_capability/);
    expect.soft(
      voiceExecutor,
      "Voice cancellation must not convert the committed cancellation into provider work",
    ).not.toMatch(/chargeNoShowFee\(|operationKind:\s*"late_cancel_charge"/);
  });

  it("an authorized desk surface can reserve a bounded partial refund and replay the same request after response loss", () => {
    expect(receptionistActions).toMatch(/getDashboardWriteClient\(slug\)/);
    expect(receptionistActions).toMatch(/canCancelBooking\(ctx\.role\)/);
    expect(paymentMigration).toMatch(/v_remaining\s*:=\s*greatest\(0,v_captured-v_refunded-v_reserved\)/);
    expect(paymentMigration).toMatch(/refund_amount_exceeds_remaining/);
    expect(paymentExecutor).toMatch(/inspect_booking_payment_operation[\s\S]{0,3400}?claim_booking_payment_operation_reconciliation/);

    expect.soft(
      receptionistActions,
      "the authorized action contract must accept an explicit positive refund amount rather than only a full-refund boolean",
    ).toMatch(/refundAmountCents\??:\s*number/);
    expect.soft(
      receptionistActions,
      "the authorized surface must bind the exact amount and stable request id into the atomic cancel/refund saga",
    ).toMatch(/cancelDeskBookingWithRefundSaga\(\{[\s\S]{0,500}?requestId,[\s\S]{0,160}?amountCents:\s*requestedRefund/);
  });

  it("desk cancel plus refund is one replayable saga with claim-before-cancel ordering", () => {
    expect.soft(
      receptionistCenter,
      "the client must retain one action UUID across a lost response and rotate it only after acknowledged completion",
    ).toMatch(/(?:cancelRefundRequest|refundRequestId|cancelActionRequest)(?:Ref|Id)[\s\S]{0,700}?crypto\.randomUUID/);
    expect.soft(
      receptionistActions,
      "the authorized action must require the client-held cancellation/refund request UUID",
    ).toMatch(/cancelDeskBooking[\s\S]{0,500}?(?:requestId|refundRequestId):\s*string/);

    expect.soft(
      deskCancelRefundSaga,
      "the app must call the single service-only DB saga instead of composing cancel and refund writes",
    ).toMatch(/rpc\("cancel_booking_with_deposit_refund_saga"[\s\S]{0,500}?p_saga_request_id:\s*input\.requestId[\s\S]{0,180}?p_refund_amount_cents:\s*input\.amountCents/);
    expect.soft(
      cancelRefundMaterialRepair,
      "the effective DB saga must inspect the stable request before the active booking status guard",
    ).toMatch(/WHERE salon_id=p_salon_id AND request_id=p_saga_request_id FOR UPDATE;[\s\S]{0,900}?IF v_booking\.status NOT IN/);
    expect.soft(
      cancelRefundMaterialRepair,
      "the effective DB saga must reserve the refund before committing cancellation in the same transaction",
    ).toMatch(/v_claim:=public\.claim_booking_payment_operation\([\s\S]{0,700}?UPDATE public\.bookings SET status='cancelled'/);
    expect.soft(
      cancelRefundMaterialRepair,
      "the saga must return the immutable material emitted by the claim, not a missing nested field from the flat loader result",
    ).toMatch(/'refund_material',v_claim->'material'/);
    expect(cancelRefundMaterialRepair).not.toMatch(
      /'refund_material',v_loaded->'material'/,
    );
    expect(cancelRefundMaterialRepair).toMatch(
      /LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''/,
    );
    expect(cancelRefundMaterialRepair).toMatch(
      /REVOKE ALL ON FUNCTION public\.cancel_booking_with_deposit_refund_saga\([\s\S]{0,180}?FROM PUBLIC, anon, authenticated;[\s\S]{0,180}?GRANT EXECUTE[\s\S]{0,180}?TO service_role;/,
    );
    expect.soft(
      deskCancelRefundSaga,
      "the action must surface succeeded, pending_provider, and unknown distinctly so callers never retry provider work blindly",
    ).toMatch(/"succeeded"[\s\S]{0,180}?"pending_provider"[\s\S]{0,180}?"unknown"/);
    expect.soft(
      receptionistActions,
      "the post-commit path must deliver the exact waitlist capability returned by the atomic saga rather than promote the booking again",
    ).toMatch(/refundOutcome\?\.ok[\s\S]{0,120}?deliverCanonicalWaitlistPromotion\(refundOutcome\.promotedWaitlist\)[\s\S]{0,120}?:\s*await promoteAndDeliverWaitlistForBooking/);
  });

  it("legacy desk Square deposit links adopt the durable ledger before provider dispatch", () => {
    expect(receptionistActions).toMatch(/requestDepositLink[\s\S]{0,2200}?getDashboardWriteClient\(slug\)/);
    expect(receptionistActions).toMatch(/\.eq\("salon_id", ctx\.salon\.id\)/);

    expect.soft(
      deskDeposits,
      "desk deposit link creation must claim the specialized DB-owned hosted-link operation before Square",
    ).toMatch(/rpc\("claim_booking_square_deposit_link"[\s\S]{0,3000}?createPaymentLink\(/);
    expect.soft(
      deskDeposits,
      "desk deposit link provider outcome must attach the exact durable Square receipt",
    ).toMatch(/createPaymentLink\([\s\S]{0,900}?rpc\("attach_booking_square_deposit_link"/);
    expect.soft(
      deskDeposits,
      "desk retry must reuse the ledger-owned provider idempotency key",
    ).not.toMatch(/createPaymentLink\([\s\S]{0,500}?idempotencyKey:\s*randomUUID\(\)/);
  });

  it("public Square customer-initiated deposits preserve DB-owned account, amount, and provider idempotency", () => {
    expect(paymentMigration).toMatch(/provider IN \('square','stripe'\)/);
    expect(paymentMigration).toMatch(/v_provider='square'[\s\S]{0,700}?merchant_id[\s\S]{0,300}?location_id/);
    expect(paymentMigration).toMatch(/square_public_configuration_missing/);
    expect(paymentMigration).toMatch(/provider_account_fingerprint/);
    expect(paymentMigration).toMatch(/provider_idempotency_key/);

    expect.soft(
      publicDepositRoute,
      "the public boundary must implement a Square customer-present branch instead of classifying every non-Stripe claim unknown",
    ).toMatch(/claim\.material\.provider\s*===\s*"square"[\s\S]{0,2400}?(?:Square|square)/);
    expect.soft(
      publicDepositRoute,
      "Square dispatch must use the claim-owned provider idempotency key",
    ).toMatch(/claim_public_square_deposit_completion[\s\S]{0,4200}?chargeCardToken\([\s\S]{0,600}?idempotencyKey:\s*claim\.providerIdempotencyKey/);
    expect.soft(
      publicDepositRoute,
      "the browser environment must be the exact DB-owned Square environment, never inferred from app NODE_ENV",
    ).toMatch(/row\?\.square_environment[\s\S]{0,800}?environment\s*!==\s*claim\.material\.providerMaterial\.providerEnvironment[\s\S]{0,800}?squareEnvironment:\s*environment/);
    expect(publicDepositRoute).not.toMatch(/squareEnvironment:\s*process\.env\.NODE_ENV/);
    expect.soft(
      publicDepositPanel,
      "the browser must complete a customer-present Square flow using only server-returned application/location material",
    ).toMatch(/(?:Square\.payments|@square\/web-sdk|SquareCard|squareApplicationId)/);
  });
});
