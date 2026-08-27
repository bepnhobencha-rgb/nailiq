import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

type BookingCardContinuationScope = "individual" | "group_organizer";
type BookingCardContinuationStage =
  | "assessment"
  | "capability"
  | "customer_action"
  | "provider_handoff";
type BookingCardContinuationReason =
  | "assessment_unavailable"
  | "card_required"
  | "capability_unavailable"
  | "consent_required"
  | "card_save_unresolved"
  | "unexpected_post_commit_error";

type RecordPendingInput = {
  salonId: string;
  bookingId: string;
  createIdempotencyKey: string;
  pricingFingerprint: string;
  scope: BookingCardContinuationScope;
  stage: BookingCardContinuationStage;
  reason: BookingCardContinuationReason;
};

type ResolveContinuationInput = {
  salonId: string;
  bookingId: string;
  createIdempotencyKey: string;
  pricingFingerprint: string;
  scope: BookingCardContinuationScope;
  reason: "card_not_required" | "not_applicable";
};

function object(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object"
    ? candidate as Record<string, unknown>
    : null;
}
/**
 * Persist a card-only continuation after the canonical booking receipt exists.
 * The RPC re-validates the exact create key and pricing fingerprint; a naked
 * booking id is never sufficient authority.
 */
export async function recordCommittedBookingCardPending(
  input: RecordPendingInput,
): Promise<boolean> {
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "record_booking_card_management_pending" as never,
      {
        p_salon_id: input.salonId,
        p_booking_id: input.bookingId,
        p_create_idempotency_key: input.createIdempotencyKey,
        p_pricing_fingerprint: input.pricingFingerprint,
        p_scope: input.scope,
        p_stage: input.stage,
        p_reason_code: input.reason,
      } as never,
    );
    return !error && object(data)?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Close the transaction-armed continuation after the trusted assessment proves
 * that customer card action is not required. Exact create binding is rechecked
 * by the RPC, so a naked booking id cannot resolve another booking's work.
 */
export async function resolveCommittedBookingCardContinuation(
  input: ResolveContinuationInput,
): Promise<boolean> {
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "resolve_booking_card_management_continuation" as never,
      {
        p_salon_id: input.salonId,
        p_booking_id: input.bookingId,
        p_create_idempotency_key: input.createIdempotencyKey,
        p_pricing_fingerprint: input.pricingFingerprint,
        p_scope: input.scope,
        p_reason_code: input.reason,
      } as never,
    );
    return !error && object(data)?.ok === true;
  } catch {
    return false;
  }
}
