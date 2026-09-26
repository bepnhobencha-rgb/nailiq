"use server";

import { z } from "zod";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { dispatchApprovedCancellationFee } from "./cancellationFeeDispatchActions";
import { decideGroupCancellationFeeReview } from "./groupCancellationFeeApprovalActions";
import { decideLateCancellationFeeReview } from "./lateCancellationFeeApprovalActions";

const bookingIdSchema = z.uuid();
const slugSchema = z.string().min(1).max(150).regex(/^[a-z0-9-]+$/);
const confirmationSchema = z.object({
  salonId: z.uuid(), bookingId: z.uuid(), reviewId: z.uuid(),
  reviewKind: z.enum(["late", "group"]),
  amountCents: z.number().int().positive().safe(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  cardBrand: z.string().trim().min(1).max(100),
  cardLast4: z.string().regex(/^\d{4}$/),
  consentPolicyVersion: z.string().min(1).max(500),
});
const waiverSchema = confirmationSchema.pick({
  salonId: true, bookingId: true, reviewId: true, reviewKind: true,
  amountCents: true, currency: true,
});

export type CancellationFeeEmailReview = {
  reviewId: string; reviewKind: "late" | "group";
  amountCents: number; currency: string; cardBrand: string; cardLast4: string;
  state: string; paymentStatus: string; consentPolicyVersion: string;
};
export type CancellationFeeEmailResult = {
  ok: true; salonId: string; salonName: string; timezone: string;
  bookingId: string; clientName: string; serviceName: string; startTimeUtc: string;
  reviews: CancellationFeeEmailReview[];
} | { ok: false; error: "unauthorized" | "not_found" | "unavailable" };

/** Read-only email destination. IDs identify records; they confer no authority. */
export async function loadCancellationFeeEmailReview(
  slug: string, bookingId: string,
): Promise<CancellationFeeEmailResult> {
  if (!slugSchema.safeParse(slug).success || !bookingIdSchema.safeParse(bookingId).success) {
    return { ok: false, error: "not_found" };
  }
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !ctx.userId || ctx.kind !== "member" || !isOwnerOrAdmin(ctx.role)) {
    return { ok: false, error: "unauthorized" };
  }
  try {
    const db = createServiceRoleClient();
    const { data: booking, error } = await db.from("bookings")
      .select("id, client_name, start_time_utc, services!bookings_service_id_fkey(name)")
      .eq("salon_id", ctx.salon.id).eq("id", bookingId).maybeSingle();
    if (error) return { ok: false, error: "unavailable" };
    if (!booking) return { ok: false, error: "not_found" };
    // Target the emailed booking, including old reviews beyond the queue's 100
    // rows. Never infer organizer liability from a member's group_id.
    const columns = "id, amount_cents, currency, card_brand, card_last4, state, payment_status, consent_policy_version";
    const results = await Promise.all([
      db.from("booking_late_cancellation_fee_reviews" as never).select(columns as never)
        .eq("salon_id" as never, ctx.salon.id).eq("booking_id" as never, bookingId),
      db.from("booking_group_cancellation_fee_reviews" as never).select(columns as never)
        .eq("salon_id" as never, ctx.salon.id).eq("organizer_booking_id" as never, bookingId),
    ]);
    if (results.some((result) => result.error)) return { ok: false, error: "unavailable" };
    const reviews = results.flatMap((result, index) =>
      ((result.data ?? []) as unknown as Record<string, unknown>[]).map((row): CancellationFeeEmailReview => ({
        reviewId: String(row.id), reviewKind: index === 0 ? "late" : "group",
        amountCents: Number(row.amount_cents), currency: String(row.currency ?? ""),
        cardBrand: String(row.card_brand ?? ""), cardLast4: String(row.card_last4 ?? ""),
        state: String(row.state ?? ""), paymentStatus: String(row.payment_status ?? ""),
        consentPolicyVersion: String(row.consent_policy_version ?? ""),
      })),
    );
    const service = booking.services as { name?: string } | { name?: string }[] | null;
    return {
      ok: true, salonId: ctx.salon.id, salonName: ctx.salon.name,
      timezone: ctx.salon.timezone, bookingId,
      clientName: booking.client_name ?? "Guest",
      serviceName: (Array.isArray(service) ? service[0]?.name : service?.name) ?? "",
      startTimeUtc: booking.start_time_utc ?? "", reviews,
    };
  } catch {
    // Do not expose raw DB/provider errors or customer details to the browser.
    return { ok: false, error: "unavailable" };
  }
}

/** Explicit POST only: record approval then reuse the existing idempotent ledger. */
export async function confirmCancellationFeeFromEmail(
  slug: string, input: z.infer<typeof confirmationSchema>,
): Promise<{ ok: true; paymentStatus: "succeeded" } | { ok: false; error: string }> {
  const parsed = confirmationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_request" };
  const expected = parsed.data;
  const matches = (review: CancellationFeeEmailReview) =>
    review.reviewId === expected.reviewId && review.reviewKind === expected.reviewKind;
  const unchanged = (review: CancellationFeeEmailReview) =>
    review.amountCents === expected.amountCents && review.currency === expected.currency &&
    review.cardBrand === expected.cardBrand && review.cardLast4 === expected.cardLast4 &&
    review.consentPolicyVersion === expected.consentPolicyVersion;
  let loaded = await loadCancellationFeeEmailReview(slug, expected.bookingId);
  if (!loaded.ok) return loaded;
  if (loaded.salonId !== expected.salonId) return { ok: false, error: "salon_mismatch" };
  let review = loaded.reviews.find(matches);
  if (!review) return { ok: false, error: "review_not_found" };
  if (!unchanged(review)) return { ok: false, error: "review_changed" };
  if (review.paymentStatus === "succeeded") return { ok: true, paymentStatus: "succeeded" };
  if (review.state === "pending_review" && review.paymentStatus === "not_authorized") {
    const decide = expected.reviewKind === "group"
      ? decideGroupCancellationFeeReview : decideLateCancellationFeeReview;
    const approved = await decide(slug, { salonId: expected.salonId, reviewId: expected.reviewId, action: "charge" });
    if (!approved.ok) return approved;
    // Re-read, never rely on a replayed approval's historic dispatch_blocked
    // status. Another tab may have paid, waived, or entered reconciliation.
    loaded = await loadCancellationFeeEmailReview(slug, expected.bookingId);
    if (!loaded.ok) return loaded;
    if (loaded.salonId !== expected.salonId) return { ok: false, error: "salon_mismatch" };
    review = loaded.reviews.find(matches);
    if (!review || !unchanged(review)) return { ok: false, error: "review_changed" };
  }
  if (review.paymentStatus === "succeeded") return { ok: true, paymentStatus: "succeeded" };
  if (review.state !== "approved_charge" || review.paymentStatus !== "dispatch_blocked") {
    return { ok: false, error: "review_not_collectible" };
  }
  // Existing dispatcher rechecks membership, release gates, immutable approval,
  // consent/card bindings and operation state atomically before provider I/O.
  return dispatchApprovedCancellationFee(slug, {
    salonId: expected.salonId, reviewId: expected.reviewId, reviewKind: expected.reviewKind,
  });
}

/** Explicit waiver only; never imports or invokes a provider mutation here. */
export async function waiveCancellationFeeFromEmail(
  slug: string, input: z.infer<typeof waiverSchema>,
): Promise<{ ok: true; state: "waived" } | { ok: false; error: string }> {
  const parsed = waiverSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_request" };
  const expected = parsed.data;
  const loaded = await loadCancellationFeeEmailReview(slug, expected.bookingId);
  if (!loaded.ok) return loaded;
  if (loaded.salonId !== expected.salonId) return { ok: false, error: "salon_mismatch" };
  const review = loaded.reviews.find((row) => row.reviewId === expected.reviewId && row.reviewKind === expected.reviewKind);
  if (!review) return { ok: false, error: "review_not_found" };
  if (review.amountCents !== expected.amountCents || review.currency !== expected.currency) {
    return { ok: false, error: "review_changed" };
  }
  if (review.state === "waived" && review.paymentStatus === "not_authorized") return { ok: true, state: "waived" };
  // Approval receipts are immutable. Never turn a previously approved or
  // uncertain charge into a waiver or imply that a waiver refunds a payment.
  if (review.state !== "pending_review" || review.paymentStatus !== "not_authorized") {
    return { ok: false, error: "review_not_waivable" };
  }
  const decide = expected.reviewKind === "group"
    ? decideGroupCancellationFeeReview : decideLateCancellationFeeReview;
  const result = await decide(slug, { salonId: expected.salonId, reviewId: expected.reviewId, action: "waive" });
  if (!result.ok) {
    // A simultaneous waiver can win after our read. Report success only from
    // the current authenticated, tenant-bound row; never replay a mutation.
    if (["review_not_pending", "idempotency_mismatch"].includes(result.error)) {
      const current = await loadCancellationFeeEmailReview(slug, expected.bookingId);
      const waived = current.ok && current.salonId === expected.salonId
        ? current.reviews.find((row) => row.reviewId === expected.reviewId && row.reviewKind === expected.reviewKind)
        : null;
      if (waived?.state === "waived" && waived.paymentStatus === "not_authorized"
        && waived.amountCents === expected.amountCents && waived.currency === expected.currency) {
        return { ok: true, state: "waived" };
      }
    }
    return result;
  }
  if (result.state !== "waived" || result.paymentStatus !== "not_authorized") {
    return { ok: false, error: "review_not_waivable" };
  }
  return { ok: true, state: "waived" };
}
