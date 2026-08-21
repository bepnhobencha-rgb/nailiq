import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { parseBookingPaymentOperationMaterial } from "./bookingPaymentOperations";
import { dispatchClaimedBookingPaymentOperation } from "./executeBookingPaymentOperation";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeskCancelRefundStatus =
  | "succeeded"
  | "pending_provider"
  | "unknown"
  | "definite_failure";

export async function cancelDeskBookingWithRefundSaga(input: {
  salonId: string;
  bookingId: string;
  requestId: string;
  amountCents: number;
  actorUserId?: string | null;
  notifyEmail: boolean;
  notifySms?: boolean;
  notificationNotBefore: string | null;
}): Promise<
  | {
      ok: true;
      idempotent: boolean;
      refundStatus: DeskCancelRefundStatus;
      refundError?: string;
      promotedWaitlist: unknown;
    }
  | { ok: false; error: string }
> {
  const db = createServiceRoleClient();
  let response: { data: unknown; error: unknown };
  try {
    response = UUID_RE.test(input.actorUserId ?? "")
      ? await db.rpc(
          "cancel_booking_with_deposit_refund_saga_for_desk" as never,
          {
            p_salon_id: input.salonId,
            p_booking_id: input.bookingId,
            p_saga_request_id: input.requestId,
            p_refund_amount_cents: input.amountCents,
            p_notify_email: input.notifyEmail,
            p_notify_sms: input.notifySms === true,
            p_actor_user_id: input.actorUserId,
            p_notification_not_before: input.notificationNotBefore,
          } as never,
        )
      : await db.rpc("cancel_booking_with_deposit_refund_saga" as never, {
          p_salon_id: input.salonId,
          p_booking_id: input.bookingId,
          p_saga_request_id: input.requestId,
          p_refund_amount_cents: input.amountCents,
          p_notify_email: false,
          p_notification_not_before: null,
        } as never);
  } catch {
    return { ok: false, error: "refund_saga_unavailable" };
  }
  const raw = Array.isArray(response.data) ? response.data[0] : response.data;
  const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (
    response.error || row?.success !== true ||
    !["cancelled_refund_claimed", "saga_replay"].includes(String(row.code ?? "")) ||
    row.booking_id !== input.bookingId || row.salon_id !== input.salonId
  ) {
    return {
      ok: false,
      error: typeof row?.code === "string" ? row.code : "refund_saga_unavailable",
    };
  }
  const cancellation = row.cancellation_result && typeof row.cancellation_result === "object"
    ? row.cancellation_result as Record<string, unknown>
    : null;
  if (
    cancellation?.status !== "cancelled" ||
    !Number.isSafeInteger(Number(row.cancellation_transition_version)) ||
    Number(row.cancellation_transition_version) <= 0
  ) return { ok: false, error: "refund_saga_invalid" };
  const promotedWaitlist = cancellation.promoted_waitlist ?? null;

  const sagaStatus = String(row.saga_status ?? "");
  const refundStatus = String(row.refund_status ?? "");
  if (sagaStatus === "refunded" || refundStatus === "succeeded") {
    return { ok: true, idempotent: row.idempotent === true, refundStatus: "succeeded", promotedWaitlist };
  }
  if (sagaStatus === "refund_pending" || refundStatus === "pending_provider") {
    return { ok: true, idempotent: row.idempotent === true, refundStatus: "pending_provider", promotedWaitlist };
  }
  if (sagaStatus === "refund_unknown" || refundStatus === "unknown") {
    return { ok: true, idempotent: row.idempotent === true, refundStatus: "unknown", promotedWaitlist };
  }
  if (sagaStatus === "refund_failed" || refundStatus === "failed") {
    return {
      ok: true,
      idempotent: row.idempotent === true,
      refundStatus: "definite_failure",
      refundError: "refund_failed",
      promotedWaitlist,
    };
  }

  const operationId = String(row.refund_operation_id ?? "");
  const attemptToken = String(row.attempt_token ?? "");
  const providerIdempotencyKey = String(row.provider_idempotency_key ?? "");
  const leaseExpiresAt = String(row.lease_expires_at ?? "");
  const materialFingerprint = String(row.refund_material_fingerprint ?? "");
  const refundMaterial = row.refund_material && typeof row.refund_material === "object"
    ? row.refund_material as Record<string, unknown>
    : null;
  const material = refundMaterial
    ? parseBookingPaymentOperationMaterial({
        ...refundMaterial,
        provider_material: row.provider_material,
        material_fingerprint: materialFingerprint,
      }, "deposit_refund")
    : null;
  if (
    !UUID_RE.test(operationId) || !UUID_RE.test(attemptToken) ||
    providerIdempotencyKey !== `nq:${operationId}` ||
    !leaseExpiresAt || !Number.isFinite(Date.parse(leaseExpiresAt)) || !material ||
    material.salonId !== input.salonId || material.bookingId !== input.bookingId ||
    material.amountCents !== input.amountCents
  ) return { ok: false, error: "refund_saga_invalid" };

  const dispatched = await dispatchClaimedBookingPaymentOperation({
    db: db as never,
    claim: {
      operationId,
      attemptToken,
      providerIdempotencyKey,
      leaseExpiresAt,
      attemptCount: 1,
      material,
    },
    reason: "Booking cancelled — deposit refund",
  });
  return dispatched.ok
    ? { ok: true, idempotent: row.idempotent === true, refundStatus: "succeeded", promotedWaitlist }
    : {
        ok: true,
        idempotent: row.idempotent === true,
        refundStatus: dispatched.status,
        refundError: dispatched.reason,
        promotedWaitlist,
      };
}
