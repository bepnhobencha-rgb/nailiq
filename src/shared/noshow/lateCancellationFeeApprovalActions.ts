"use server";

import { createHash } from "node:crypto";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

export type LateCancellationFeeReviewQueueItem = {
  reviewId: string;
  bookingId: string;
  clientName: string;
  serviceName: string;
  startTimeUtc: string;
  amountCents: number;
  feePercent: number;
  currency: string;
  cardBrand: string;
  cardLast4: string;
  state: "pending_review" | "approved_charge" | "waived" | "invalidated";
  paymentStatus: string;
  consentPolicyVersion: string;
  graceEndedAt: string | null;
  requestedAt: string;
};

function stableApprovalRequestId(
  reviewId: string,
  action: "charge" | "waive",
): string {
  const bytes = createHash("sha256")
    .update(`nailiq:late-cancellation-fee-approval:v1:${reviewId}:${action}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function loadLateCancellationFeeReviewQueue(
  slug: string,
): Promise<LateCancellationFeeReviewQueueItem[]> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwnerOrAdmin(ctx.role)) return [];
  const db = createServiceRoleClient();
  const { data } = await db
    .from("booking_late_cancellation_fee_reviews" as never)
    .select("id, booking_id, amount_cents, fee_percent, currency, card_brand, card_last4, state, payment_status, consent_policy_version, policy_snapshot, requested_at" as never)
    .eq("salon_id" as never, ctx.salon.id)
    .order("requested_at" as never, { ascending: false })
    .limit(100);
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];
  const bookingIds = rows.map((row) => String(row.booking_id));
  const { data: bookings } = await db
    .from("bookings" as never)
    .select("id, client_name, start_time_utc, services!bookings_service_id_fkey(name)" as never)
    .eq("salon_id" as never, ctx.salon.id)
    .in("id" as never, bookingIds);
  const byId = new Map(
    ((bookings ?? []) as unknown as Array<Record<string, unknown>>)
      .map((booking) => [String(booking.id), booking]),
  );
  return rows.map((row) => {
    const booking = byId.get(String(row.booking_id));
    const service = booking?.services as
      | { name?: unknown }
      | Array<{ name?: unknown }>
      | null;
    const serviceName = Array.isArray(service)
      ? String(service[0]?.name ?? "")
      : String(service?.name ?? "");
    const snapshot = row.policy_snapshot && typeof row.policy_snapshot === "object"
      ? row.policy_snapshot as Record<string, unknown>
      : {};
    return {
      reviewId: String(row.id),
      bookingId: String(row.booking_id),
      clientName: String(booking?.client_name ?? "Guest"),
      serviceName,
      startTimeUtc: String(booking?.start_time_utc ?? ""),
      amountCents: Number(row.amount_cents ?? 0),
      feePercent: Number(row.fee_percent ?? 0),
      currency: String(row.currency ?? "CAD"),
      cardBrand: String(row.card_brand ?? "Card"),
      cardLast4: String(row.card_last4 ?? ""),
      state: String(row.state) as LateCancellationFeeReviewQueueItem["state"],
      paymentStatus: String(row.payment_status ?? "not_authorized"),
      consentPolicyVersion: String(row.consent_policy_version ?? ""),
      graceEndedAt: typeof snapshot.grace_ends_at === "string"
        ? snapshot.grace_ends_at
        : null,
      requestedAt: String(row.requested_at ?? ""),
    };
  });
}

export async function decideLateCancellationFeeReview(
  slug: string,
  input: {
    salonId: string;
    reviewId: string;
    action: "charge" | "waive";
  },
): Promise<
  { ok: true; state: string; paymentStatus: string } |
  { ok: false; error: string }
> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwnerOrAdmin(ctx.role) || !ctx.userId) {
    return { ok: false, error: "unauthorized" };
  }
  if (ctx.salon.id !== input.salonId) {
    return { ok: false, error: "salon_mismatch" };
  }
  const { data, error } = await createServiceRoleClient().rpc(
    "decide_late_cancellation_fee_review" as never,
    {
      p_review_id: input.reviewId,
      p_salon_id: ctx.salon.id,
      p_actor_user_id: ctx.userId,
      p_actor_role: String(ctx.role),
      p_approval_request_id: stableApprovalRequestId(
        input.reviewId,
        input.action,
      ),
      p_action: input.action,
    } as never,
  );
  const raw = Array.isArray(data) ? data[0] : data;
  const row = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : null;
  if (error || row?.success !== true) {
    return {
      ok: false,
      error: typeof row?.code === "string"
        ? row.code
        : "decision_unavailable",
    };
  }
  return {
    ok: true,
    state: String(row.state ?? ""),
    paymentStatus: String(row.payment_status ?? "not_authorized"),
  };
}
