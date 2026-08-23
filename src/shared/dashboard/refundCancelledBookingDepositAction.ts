"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { runCancelledBookingRemainingDepositRefund } from "@/shared/payments/executeBookingPaymentOperation";
import { isArchivedBookingFeatureAvailable } from "@/shared/dashboard/archivedBookingFeatureAccess";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RefundCancelledBookingDepositResult =
  | { ok: true; status: "succeeded" }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "forbidden"
        | "feature_disabled"
        | "invalid_booking"
        | "invalid_request"
        | "not_found"
        | "not_cancelled"
        | "refund_changed"
        | "request_conflict"
        | "not_refundable"
        | "reconciliation_required"
        | "provider_failed"
        | "server_error";
    };

function mapPaymentFailure(
  status: "pending_provider" | "definite_failure" | "unknown" | "not_claimed",
  reason: string,
): RefundCancelledBookingDepositResult {
  if (status === "pending_provider" || status === "unknown") {
    return { ok: false, error: "reconciliation_required" };
  }
  if (status === "definite_failure") {
    return { ok: false, error: "provider_failed" };
  }
  if (
    reason === "operation_conflict" ||
    reason === "payment_replay_material_conflict"
  ) {
    return { ok: false, error: "request_conflict" };
  }
  if (
    reason === "refund_remaining_changed" ||
    reason === "refund_amount_exceeds_remaining" ||
    reason === "amount_changed"
  ) {
    return { ok: false, error: "refund_changed" };
  }
  if (reason === "booking_not_cancelled") {
    return { ok: false, error: "not_cancelled" };
  }
  if (reason === "refund_reconciliation_required") {
    return { ok: false, error: "reconciliation_required" };
  }
  if (
    reason === "deposit_fully_refunded" ||
    reason === "deposit_not_refundable" ||
    reason === "legacy_payment_not_ledgered" ||
    reason === "parent_payment_binding_mismatch"
  ) {
    return { ok: false, error: "not_refundable" };
  }
  return { ok: false, error: "server_error" };
}

/**
 * Owner/Admin-only financial action for one archived cancelled booking.
 * Browser input contains only identity, a stable logical request UUID, and the
 * amount the user visibly confirmed. SQL re-derives and atomically compares
 * the actual remaining balance while the booking is locked as cancelled.
 */
export async function refundCancelledBookingDepositRemaining(
  slug: string,
  input: {
    bookingId: string;
    requestId: string;
    expectedRemainingCents: number;
  },
): Promise<RefundCancelledBookingDepositResult> {
  const normalizedSlug = String(slug ?? "").trim();
  const bookingId = String(input?.bookingId ?? "").trim();
  const requestId = String(input?.requestId ?? "").trim();
  const expectedRemainingCents = Number(input?.expectedRemainingCents);
  if (!normalizedSlug || !UUID_RE.test(bookingId)) {
    return { ok: false, error: "invalid_booking" };
  }
  if (
    !UUID_RE.test(requestId) ||
    !Number.isSafeInteger(expectedRemainingCents) ||
    expectedRemainingCents <= 0
  ) {
    return { ok: false, error: "invalid_request" };
  }

  const ctx = await getDashboardWriteClient(normalizedSlug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (
    ctx.kind !== "member" ||
    !ctx.userId ||
    !UUID_RE.test(ctx.userId) ||
    !isOwnerOrAdmin(ctx.role)
  ) {
    return { ok: false, error: "forbidden" };
  }
  // User-scoped + tenant-scoped read before any service-role client/provider
  // is created. SQL repeats this fence under a booking-row lock.
  const { data: booking, error: bookingError } = await ctx.supabase
    .from("bookings")
    .select("id, status")
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();
  if (bookingError) return { ok: false, error: "server_error" };
  if (!booking?.id) return { ok: false, error: "not_found" };
  if (booking.status !== "cancelled") {
    return { ok: false, error: "not_cancelled" };
  }
  if (!(await isArchivedBookingFeatureAvailable(ctx.salon))) {
    return { ok: false, error: "feature_disabled" };
  }

  let db: ReturnType<typeof createServiceRoleClient>;
  try {
    db = createServiceRoleClient();
  } catch {
    return { ok: false, error: "server_error" };
  }
  const outcome = await runCancelledBookingRemainingDepositRefund({
    db: db as never,
    salonId: ctx.salon.id,
    bookingId,
    requestId,
    expectedRemainingCents,
  });
  return outcome.ok
    ? { ok: true, status: "succeeded" }
    : mapPaymentFailure(outcome.status, outcome.reason);
}
