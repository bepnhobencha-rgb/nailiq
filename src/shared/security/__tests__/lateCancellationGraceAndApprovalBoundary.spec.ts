import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("late cancellation grace and approval boundary", () => {
  const migration = read(
    "supabase/migrations/20260831013000_add_late_cancel_group_fee_safety.sql",
  );
  const dispatchMigration = read(
    "supabase/migrations/20260831021500_add_approved_cancellation_fee_dispatch.sql",
  );
  const evaluator = read("src/shared/noshow/lateCancellationPolicy.ts");
  const actions = read(
    "src/shared/noshow/lateCancellationFeeApprovalActions.ts",
  );
  const queue = read(
    "src/components/dashboard/LateCancellationFeeApprovalQueue.tsx",
  );
  const dispatchActions = read(
    "src/shared/noshow/cancellationFeeDispatchActions.ts",
  );
  const releaseGate = read("src/shared/release/v1IntegrationScope.ts");

  it("enforces one 15-minute short-notice grace in application and database truth", () => {
    expect(evaluator).toContain("SHORT_NOTICE_GRACE_MINUTES = 15");
    expect(evaluator).toContain("shortNoticeBooking");
    expect(evaluator).toContain("graceActive");
    expect(migration).toContain("interval '15 minutes'");
    expect(migration).toContain("short_notice_grace_active");
    expect(migration).toContain("protect_late_cancellation_lock_policy");
    expect(migration).toContain("preview_booking_group_cancellation_for_desk");
  });

  it("caps both individual and group fee snapshots at 20 percent", () => {
    expect(evaluator).toContain("MAX_LATE_CANCELLATION_PERCENT = 20");
    expect(migration).toContain("'max_fee_percent', 20");
    expect(migration).toMatch(/v_late_percent := least\(20,/);
    expect(migration).toContain("fee_percent BETWEEN 0 AND 20");
  });

  it("captures cancellation review without provider dispatch", () => {
    expect(migration).toContain("capture_late_cancellation_fee_review");
    expect(migration).toContain("AFTER UPDATE OF status ON public.bookings");
    expect(migration).toContain("booking_late_cancellation_fee_reviews");
    expect(migration).not.toMatch(/api\.squareup\.com|api\.twilio\.com|resend\.com/);
  });

  it("requires owner or admin and an immutable exact-amount receipt", () => {
    expect(migration).toContain("booking_late_cancellation_fee_approval_receipts");
    expect(migration).toContain("booking_late_cancellation_fee_receipts_immutable");
    expect(migration).toMatch(/m\.role IN \('owner', 'admin'\)/);
    expect(migration).toContain("v_review.amount_cents");
    expect(actions).toContain("stableApprovalRequestId");
    expect(queue).toContain("Đã duyệt đúng số tiền");
  });

  it("keeps approval separate and requires a second gated collect action", () => {
    expect(migration).toContain("dispatch_blocked");
    expect(queue).toContain("Approval does not move money");
    expect(actions).not.toContain("resolvePaymentProvider");
    expect(dispatchMigration).toContain("claim_approved_cancellation_fee_payment");
    expect(dispatchMigration).toContain("approved_cancellation_fee_dispatch");
    expect(dispatchMigration).toContain("booking_late_cancellation_fee_approval_receipts");
    expect(dispatchMigration).toContain("booking_group_cancellation_fee_approval_receipts");
    expect(dispatchMigration).not.toMatch(/api\.squareup\.com|api\.twilio\.com|resend\.com/);
    expect(dispatchActions).toMatch(
      /allowsApprovedCancellationFeeDispatch\(\)[\s\S]*dispatch_release_disabled/,
    );
    expect(queue).toContain("item.paymentStatus === \"dispatch_blocked\"");
    expect(queue).toContain("window.confirm");
    expect(releaseGate).toContain("NAILIQ_APPROVED_CANCELLATION_FEE_DISPATCH");
  });
});
