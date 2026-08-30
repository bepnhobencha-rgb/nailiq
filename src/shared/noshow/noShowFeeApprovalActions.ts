"use server";

import { createHash, randomUUID } from "node:crypto";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  canMarkNoShow,
  isOwnerOrAdmin,
} from "@/shared/lib/salonMemberRole";
import { allowsApprovedNoShowChargeDispatch } from "@/shared/release/v1IntegrationScope";
import { runAuthoritativeBookingPaymentOperation } from "@/shared/payments/executeBookingPaymentOperation";

type Result = { ok: true; code: string; reviewId: string; paymentStatus?: string } |
  { ok: false; error: string };

function record(value: unknown): Record<string, unknown> | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
}

function roleName(role: unknown): string {
  return typeof role === "string" ? role : "";
}

function stableApprovalRequestId(reviewId: string, action: "charge" | "waive"): string {
  const bytes = createHash("sha256")
    .update(`nailiq:no-show-fee-approval:v1:${reviewId}:${action}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function deterministicRecommendation(
  db: ReturnType<typeof createServiceRoleClient>,
  salonId: string,
  decisionId: string,
): Promise<{ recommendation: "charge" | "review"; reasons: string[] }> {
  const { data: decision } = await db
    .from("booking_no_show_decisions" as never)
    .select("booking_id" as never)
    .eq("id" as never, decisionId)
    .eq("salon_id" as never, salonId)
    .maybeSingle();
  const bookingId = String((decision as { booking_id?: unknown } | null)?.booking_id ?? "");
  if (!bookingId) return { recommendation: "review", reasons: ["decision_context_unavailable"] };
  const { data: booking } = await db
    .from("bookings" as never)
    .select("client_phone, no_show_risk_score" as never)
    .eq("id" as never, bookingId)
    .eq("salon_id" as never, salonId)
    .maybeSingle();
  const row = booking as { client_phone?: string | null; no_show_risk_score?: number | null } | null;
  const phone = String(row?.client_phone ?? "").trim();
  let priorCount = 0;
  if (phone) {
    const { count } = await db
      .from("bookings" as never)
      .select("id", { count: "exact", head: true })
      .eq("salon_id" as never, salonId)
      .eq("client_phone" as never, phone)
      .eq("status" as never, "no_show")
      .neq("id" as never, bookingId);
    priorCount = count ?? 0;
  }
  const risk = Number(row?.no_show_risk_score ?? 0);
  const reasons = [
    priorCount > 0 ? "prior_no_show" : "first_recorded_no_show",
    risk >= 70 ? "high_risk_score" : "standard_risk_score",
    "owner_review_required",
  ];
  return {
    recommendation: priorCount > 0 && risk >= 70 ? "charge" : "review",
    reasons,
  };
}

export async function requestNoShowFeeReview(
  slug: string,
  input: { salonId: string; decisionId: string; requestId?: string },
): Promise<Result> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !canMarkNoShow(ctx.role)) return { ok: false, error: "unauthorized" };
  if (ctx.salon.id !== input.salonId || !ctx.userId) return { ok: false, error: "salon_mismatch" };
  const db = createServiceRoleClient();
  const recommendation = await deterministicRecommendation(db, ctx.salon.id, input.decisionId);
  const requestId = input.requestId ?? randomUUID();
  const { data, error } = await db.rpc("request_booking_no_show_fee_review" as never, {
    p_request_id: requestId,
    p_decision_id: input.decisionId,
    p_salon_id: ctx.salon.id,
    p_actor_user_id: ctx.userId,
    p_actor_role: roleName(ctx.role),
    p_ai_recommendation: recommendation.recommendation,
    p_ai_reason_codes: recommendation.reasons,
  } as never);
  const row = record(data);
  if (error || row?.success !== true || typeof row.review_id !== "string") {
    return { ok: false, error: typeof row?.code === "string" ? row.code : "review_unavailable" };
  }
  return {
    ok: true,
    code: String(row.code),
    reviewId: row.review_id,
    paymentStatus: typeof row.payment_status === "string" ? row.payment_status : undefined,
  };
}

export async function decideNoShowFeeReview(
  slug: string,
  input: {
    salonId: string;
    reviewId: string;
    action: "charge" | "waive";
    approvalRequestId?: string;
  },
): Promise<Result> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwnerOrAdmin(ctx.role) || !ctx.userId) return { ok: false, error: "unauthorized" };
  if (ctx.salon.id !== input.salonId) return { ok: false, error: "salon_mismatch" };
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc("decide_booking_no_show_fee_review" as never, {
    p_review_id: input.reviewId,
    p_salon_id: ctx.salon.id,
    p_actor_user_id: ctx.userId,
    p_actor_role: roleName(ctx.role),
    p_approval_request_id: input.approvalRequestId
      ?? stableApprovalRequestId(input.reviewId, input.action),
    p_action: input.action,
  } as never);
  const row = record(data);
  if (error || row?.success !== true) {
    return { ok: false, error: typeof row?.code === "string" ? row.code : "decision_unavailable" };
  }
  return {
    ok: true,
    code: String(row.code),
    reviewId: input.reviewId,
    paymentStatus: typeof row.payment_status === "string" ? row.payment_status : undefined,
  };
}

/**
 * Provider dispatch is a separate, explicitly gated action. Merely approving a
 * fee never reaches Square. The environment gate and salon allowlist must both
 * be true, and SQL rechecks the immutable owner/admin receipt before returning
 * the stable request id used by the payment ledger.
 */
export async function dispatchApprovedNoShowFee(
  slug: string,
  input: { salonId: string; reviewId: string },
): Promise<Result> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwnerOrAdmin(ctx.role) || !ctx.userId) return { ok: false, error: "unauthorized" };
  if (ctx.salon.id !== input.salonId) return { ok: false, error: "salon_mismatch" };
  if (!allowsApprovedNoShowChargeDispatch()) {
    return { ok: false, error: "dispatch_release_disabled" };
  }
  const db = createServiceRoleClient();
  const { data: salon } = await db
    .from("salons" as never)
    .select("feature_flags" as never)
    .eq("id" as never, ctx.salon.id)
    .maybeSingle();
  const flags = (salon as { feature_flags?: Record<string, unknown> } | null)?.feature_flags ?? {};
  if (flags.approved_no_show_charge_dispatch !== true) {
    return { ok: false, error: "salon_not_allowlisted" };
  }

  const { data: authorized, error: authError } = await db.rpc(
    "authorize_approved_no_show_fee_dispatch" as never,
    {
      p_review_id: input.reviewId,
      p_salon_id: ctx.salon.id,
      p_actor_user_id: ctx.userId,
      p_actor_role: roleName(ctx.role),
    } as never,
  );
  const auth = record(authorized);
  if (authError || auth?.success !== true) {
    return { ok: false, error: typeof auth?.code === "string" ? auth.code : "dispatch_not_authorized" };
  }
  const bookingId = String(auth.booking_id ?? "");
  const requestId = String(auth.request_id ?? "");
  const amountCents = Number(auth.amount_cents ?? 0);
  if (!bookingId || !requestId || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return { ok: false, error: "dispatch_material_invalid" };
  }
  const outcome = await runAuthoritativeBookingPaymentOperation({
    db: {
      rpc: async (name, args) => {
        const result = await db.rpc(name as never, args as never);
        return { data: result.data, error: result.error };
      },
    },
    salonId: ctx.salon.id,
    bookingId,
    requestId,
    operationKind: "noshow_charge",
    amountCents,
    note: "Approved no-show fee",
    referenceId: `booking:${bookingId}`,
    paymentAuthorization: {
      kind: "approved_no_show_fee",
      reviewId: input.reviewId,
    },
  });
  if (!outcome.operationId) {
    return {
      ok: false,
      error: outcome.ok ? "payment_operation_missing" : outcome.reason,
    };
  }
  const paymentStatus = outcome.ok
    ? "succeeded"
    : outcome.status === "definite_failure"
      ? "failed"
      : outcome.status;
  await db.rpc("record_approved_no_show_fee_dispatch_outcome" as never, {
    p_review_id: input.reviewId,
    p_salon_id: ctx.salon.id,
    p_payment_operation_id: outcome.operationId,
    p_status: paymentStatus,
    p_error_code: outcome.ok ? null : outcome.reason,
  } as never);
  return outcome.ok
    ? { ok: true, code: "charge_succeeded", reviewId: input.reviewId, paymentStatus }
    : { ok: false, error: outcome.reason };
}

export type NoShowFeeReviewQueueItem = {
  reviewId: string | null;
  decisionId: string;
  bookingId: string;
  clientName: string;
  serviceName: string;
  startTimeUtc: string;
  amountCents: number;
  currency: string;
  cardBrand: string;
  cardLast4: string;
  state: "ready_to_request" | "pending" | "approved_charge" | "waived" | "invalidated";
  paymentStatus: string;
  aiRecommendation: "charge" | "waive" | "review";
  aiReasonCodes: string[];
  consentPolicyVersion: string;
};

export async function loadNoShowFeeReviewQueue(slug: string): Promise<NoShowFeeReviewQueueItem[]> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwnerOrAdmin(ctx.role)) return [];
  const db = createServiceRoleClient();
  const [{ data: decisions }, { data: reviews }] = await Promise.all([
    db.rpc("list_booking_no_show_fee_queue_decisions" as never, {
      p_salon_id: ctx.salon.id,
    } as never),
    db.from("booking_no_show_fee_reviews" as never)
      .select("id, booking_id, no_show_decision_id, state, amount_cents, currency, card_brand, card_last4, payment_status, ai_recommendation, ai_reason_codes, consent_policy_version" as never)
      .eq("salon_id" as never, ctx.salon.id)
      .order("requested_at" as never, { ascending: false })
      .limit(100),
  ]);
  const decisionRows = (decisions ?? []) as unknown as Array<{ id: string; booking_id: string }>;
  const reviewRows = (reviews ?? []) as unknown as Array<Record<string, unknown>>;
  const bookingIds = [...new Set([
    ...decisionRows.map((row) => row.booking_id),
    ...reviewRows.map((row) => String(row.booking_id)),
  ])];
  if (bookingIds.length === 0) return [];
  const { data: bookings } = await db.from("bookings" as never)
    .select("id, client_name, start_time_utc, noshow_fee_cents, noshow_card_brand, noshow_card_last4, noshow_consent_meta, services!bookings_service_id_fkey(name)" as never)
    .eq("salon_id" as never, ctx.salon.id)
    .in("id" as never, bookingIds);
  const bookingMap = new Map(
    ((bookings ?? []) as unknown as Array<Record<string, unknown>>)
      .map((row) => [String(row.id), row]),
  );
  const reviewByDecision = new Map(reviewRows.map((row) => [String(row.no_show_decision_id), row]));
  return decisionRows.flatMap((decision) => {
    const booking = bookingMap.get(decision.booking_id);
    if (!booking) return [];
    const review = reviewByDecision.get(decision.id);
    const meta = booking.noshow_consent_meta && typeof booking.noshow_consent_meta === "object"
      ? booking.noshow_consent_meta as Record<string, unknown>
      : {};
    const fee = Number(review?.amount_cents ?? booking.noshow_fee_cents ?? 0);
    const last4 = String(review?.card_last4 ?? booking.noshow_card_last4 ?? "");
    const version = String(review?.consent_policy_version ?? meta.policyVersion ?? "");
    if (fee <= 0 || !/^\d{4}$/.test(last4) || !/^nsp_[0-9a-f]{64}$/.test(version)) return [];
    const service = booking.services as { name?: unknown } | null;
    return [{
      reviewId: review ? String(review.id) : null,
      decisionId: decision.id,
      bookingId: decision.booking_id,
      clientName: String(booking.client_name ?? "—"),
      serviceName: String(service?.name ?? "—"),
      startTimeUtc: String(booking.start_time_utc ?? ""),
      amountCents: fee,
      currency: String(review?.currency ?? meta.currency ?? "CAD"),
      cardBrand: String(review?.card_brand ?? booking.noshow_card_brand ?? "Card"),
      cardLast4: last4,
      state: review ? String(review.state) as NoShowFeeReviewQueueItem["state"] : "ready_to_request",
      paymentStatus: String(review?.payment_status ?? "not_authorized"),
      aiRecommendation: String(review?.ai_recommendation ?? "review") as NoShowFeeReviewQueueItem["aiRecommendation"],
      aiReasonCodes: Array.isArray(review?.ai_reason_codes)
        ? review.ai_reason_codes.filter((value): value is string => typeof value === "string")
        : [],
      consentPolicyVersion: version,
    }];
  });
}
