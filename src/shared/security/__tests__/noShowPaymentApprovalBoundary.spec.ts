import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("no-show and late-cancel payment truth boundary", () => {
  const migration = read(
    "supabase/migrations/20260830210000_enforce_no_show_payment_approval.sql",
  );
  const executor = read("src/shared/payments/executeBookingPaymentOperation.ts");
  const approvalActions = read("src/shared/noshow/noShowFeeApprovalActions.ts");
  const cancelRoute = read("src/app/api/booking/cancel-action/route.ts");
  const voiceExecutor = read("src/shared/voiceai/toolExecutor.ts");

  it("requires the dedicated approved-review marker before any no-show ledger work", () => {
    expect(executor).toMatch(
      /operationKind === "noshow_charge"[\s\S]{0,320}?fee_approval_required/,
    );
    expect(approvalActions).toMatch(
      /paymentAuthorization:\s*\{[\s\S]{0,120}?kind:\s*"approved_no_show_fee"[\s\S]{0,120}?reviewId:\s*input\.reviewId/,
    );
  });

  it("binds provider entry to the exact immutable Owner/Admin receipt", () => {
    expect(migration).toContain("enforce_no_show_payment_operation_approval");
    expect(migration).toMatch(/NEW\.operation_kind <> 'noshow_charge'/);
    expect(migration).toMatch(/v_receipt\.action <> 'charge'/);
    expect(migration).toMatch(/v_receipt\.approval_request_id IS DISTINCT FROM v_review\.approval_request_id/);
    expect(migration).toMatch(/v_receipt\.consent_snapshot_hash IS DISTINCT FROM v_review\.consent_snapshot_hash/);
    expect(migration).toMatch(/v_review\.amount_cents IS DISTINCT FROM NEW\.amount_cents/);
  });

  it("denies direct service-role writes to approval truth", () => {
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.booking_no_show_fee_reviews[\s\S]{0,80}?FROM service_role/,
    );
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.booking_no_show_fee_approval_receipts[\s\S]{0,80}?FROM service_role/,
    );
  });

  it("accepts success only from the exact succeeded ledger operation with provider receipt", () => {
    expect(migration).toMatch(/p_status IS DISTINCT FROM v_operation\.status/);
    expect(migration).toMatch(
      /p_status = 'succeeded'[\s\S]{0,160}?v_operation\.provider_payment_id/,
    );
    expect(migration).toContain("operation_outcome_mismatch");
    expect(migration).toContain("succeeded_receipt_invalid");
  });

  it("keeps committed cancellation successful and fee dispatch out of web and voice", () => {
    expect(cancelRoute).not.toContain("chargeNoShowFee");
    expect(cancelRoute).not.toContain("payment_reconciliation_required");
    expect(cancelRoute).not.toContain("payment_unavailable");
    expect(cancelRoute).toContain('"approval_required" as const');
    expect(cancelRoute).toContain("bookingCommitted: true");
    expect(voiceExecutor).not.toContain("chargeNoShowFee(bookingId!");
    expect(voiceExecutor).toContain('"approval_required" as const');
  });

  it("fails closed for late-cancel provider entry until its own approval workflow exists", () => {
    expect(executor).toMatch(
      /operationKind === "late_cancel_charge"[\s\S]{0,240}?fee_approval_required/,
    );
    expect(migration).toMatch(
      /NEW\.operation_kind = 'late_cancel_charge'[\s\S]{0,260}?NI009/,
    );
  });
});
