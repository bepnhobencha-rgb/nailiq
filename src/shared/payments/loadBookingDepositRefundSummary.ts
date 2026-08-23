import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

const ACTIVE_REFUND_STATUSES = [
  "sending",
  "pending_provider",
  "reconciling",
  "unknown",
] as const;

export type BookingDepositRefundSummary = {
  capturedCents: number;
  refundedCents: number;
  reservedCents: number;
  remainingRefundableCents: number;
  availability: "available" | "fully_refunded" | "reconciliation_required";
};

type BookingPaymentBinding = {
  deposit_status?: unknown;
  deposit_refunded_cents?: unknown;
  square_payment_id?: unknown;
  stripe_payment_intent_id?: unknown;
};

type ParentCharge = {
  id?: unknown;
  provider?: unknown;
  provider_payment_id?: unknown;
  amount_cents?: unknown;
};

function safeCents(value: unknown): number | null {
  const cents = Number(value);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

function nonemptyString(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

/**
 * Reads only the minimum service-owned ledger fields needed to render or
 * validate a deposit-refund summary. Provider credentials/material never
 * leave this module.
 *
 * The caller must authenticate and authorize before supplying a service-role
 * client. Every query remains bound to the exact salon + booking as a second
 * tenant fence.
 */
export async function loadBookingDepositRefundSummary(args: {
  db: SupabaseClient;
  salonId: string;
  bookingId: string;
  booking: BookingPaymentBinding;
}): Promise<BookingDepositRefundSummary | null> {
  const depositStatus = nonemptyString(args.booking.deposit_status);
  const refundedCents = safeCents(args.booking.deposit_refunded_cents ?? 0);
  if (
    !["paid", "refunded"].includes(depositStatus ?? "") ||
    refundedCents === null
  ) {
    return null;
  }

  const { data: parentRaw, error: parentError } = await args.db
    .from("booking_payment_operations")
    .select("id, provider, provider_payment_id, amount_cents")
    .eq("salon_id", args.salonId)
    .eq("booking_id", args.bookingId)
    .eq("operation_kind", "deposit_charge")
    .eq("status", "succeeded")
    .not("provider_payment_id", "is", null)
    .order("completed_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  const parent = parentRaw as ParentCharge | null;
  if (parentError || !parent) return null;

  const parentId = nonemptyString(parent.id);
  const provider = nonemptyString(parent.provider);
  const providerPaymentId = nonemptyString(parent.provider_payment_id);
  const capturedCents = safeCents(parent.amount_cents);
  const bookingPaymentId = provider === "square"
    ? nonemptyString(args.booking.square_payment_id)
    : provider === "stripe"
      ? nonemptyString(args.booking.stripe_payment_intent_id)
      : null;
  if (
    !parentId || !providerPaymentId || !bookingPaymentId ||
    bookingPaymentId !== providerPaymentId || capturedCents === null ||
    capturedCents <= 0 || refundedCents > capturedCents
  ) {
    return null;
  }

  const { data: activeRaw, error: activeError } = await args.db
    .from("booking_payment_operations")
    .select("amount_cents, parent_operation_id")
    .eq("salon_id", args.salonId)
    .eq("booking_id", args.bookingId)
    .eq("operation_kind", "deposit_refund")
    .in("status", [...ACTIVE_REFUND_STATUSES]);
  if (activeError) return null;

  let reservedCents = 0;
  for (const value of activeRaw ?? []) {
    const row = value as { amount_cents?: unknown; parent_operation_id?: unknown };
    const amount = safeCents(row.amount_cents);
    const refundParentId = nonemptyString(row.parent_operation_id);
    if (amount === null || refundParentId !== parentId) return null;
    reservedCents += amount;
    if (!Number.isSafeInteger(reservedCents)) return null;
  }

  const remainingRefundableCents = Math.max(
    0,
    capturedCents - refundedCents - reservedCents,
  );
  return {
    capturedCents,
    refundedCents,
    reservedCents,
    remainingRefundableCents,
    availability: reservedCents > 0
      ? "reconciliation_required"
      : remainingRefundableCents > 0
        ? "available"
        : "fully_refunded",
  };
}
