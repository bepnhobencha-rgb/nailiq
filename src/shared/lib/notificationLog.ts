/**
 * Central helper for logging outbound SMS/email notifications to
 * `booking_notifications`. Used by all send paths so the owner dashboard
 * and Twilio webhook have a single source of truth.
 *
 * All functions are server-side only (use service role client).
 */

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

function safeLogError(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown } | null;
  const code = typeof value?.code === "string" ? `${value.code}:` : "";
  const message =
    typeof value?.message === "string"
      ? value.message
      : error instanceof Error
        ? error.message
        : "database_error";
  return `${code}${message}`
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
}

export type NotificationType =
  | "booking_confirmation"
  | "reminder_24h"
  | "reminder_3h"
  | "review_request"
  // Legacy scheduled staff create/reschedule/cancel delivery. Kept distinct
  // from the one-per-booking confirmation retry state machine and its partial
  // unique key.
  | "staff_action"
  // Receptionist "invite now" — texting a waitlisted customer the claim link
  // when a slot opens. booking_id is null (the entry isn't a booking yet).
  | "waitlist_invite"
  // Inbound customer SMS replies handled by /api/twilio/inbound.
  | "inbound_confirm"
  | "inbound_cancel";

export type NotificationChannel = "sms" | "email";

export interface LogNotificationParams {
  bookingId: string | null;
  salonId: string;
  notificationType: NotificationType;
  channel: NotificationChannel;
  clientPhone?: string | null;
  messageSid?: string | null;
  bodyPreview?: string | null;
  /** Pass false when the send failed before a SID was returned. */
  ok: boolean;
  /** Provider-aware status. Prefer this for SMS so suppression and ambiguous
   * transport outcomes are never flattened into sent/failed. */
  deliveryStatus?: NotificationFinalStatus;
  errorMessage?: string | null;
}

/** Insert a notification row. Returns the new row id (used for deferred updates). */
export async function logNotification(
  params: LogNotificationParams,
): Promise<string | null> {
  const supabase = createServiceRoleClient();
  const now = new Date().toISOString();
  const status = params.deliveryStatus ?? (params.ok ? "sent" : "failed");
  const accepted = status === "sent";
  const failed = status === "failed";

  const row = {
    booking_id: params.bookingId,
    salon_id: params.salonId,
    notification_type: params.notificationType,
    channel: params.channel,
    status,
    client_phone: params.clientPhone ?? null,
    twilio_message_sid: params.messageSid ?? null,
    body_preview: params.bodyPreview ? params.bodyPreview.slice(0, 120) : null,
    sent_at: accepted ? now : null,
    failed_at: failed ? now : null,
    error_message: params.errorMessage ?? null,
  };

  const { data, error } = await supabase
    .from("booking_notifications" as never)
    .insert(row)
    .select("id")
    .maybeSingle();

  if (error) {
    // Booking confirmations are protected by a partial unique index. A second
    // caller means the notification was already recorded; this is an expected
    // idempotency outcome, not a production error.
    if ((error as { code?: string }).code === "23505") return null;
    console.error("[logNotification]", safeLogError(error));
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Result of an idempotent claim attempt:
 *  - string  → THIS caller won; row id to update once the send resolves.
 *  - "skip"  → another path already owns this (booking, type, channel); do NOT send.
 *  - "unguarded" → couldn't claim atomically (e.g. no salonId, or a non-unique
 *                  DB error); proceed best-effort WITHOUT a row (avoids dropping
 *                  a real send just because logging hiccuped).
 */
export type NotificationClaim = string | "skip" | "unguarded";

/**
 * Atomically claim the right to send a one-per-booking notification, relying on
 * the partial unique index `(booking_id, channel) where notification_type =
 * 'booking_confirmation'`. The first caller inserts a `status='sending'` row and
 * wins; concurrent callers hit a 23505 unique violation and get "skip". This is
 * what makes the two confirmation-email paths (publicBookingSideEffects +
 * /api/booking/sms-confirm) race-proof — previously only one had a (racy) guard.
 */
export async function claimNotificationOnce(
  params: Omit<LogNotificationParams, "ok">,
): Promise<NotificationClaim> {
  const supabase = createServiceRoleClient();
  const row = {
    booking_id: params.bookingId,
    salon_id: params.salonId,
    notification_type: params.notificationType,
    channel: params.channel,
    status: "sending",
    client_phone: params.clientPhone ?? null,
    twilio_message_sid: params.messageSid ?? null,
    body_preview: params.bodyPreview ? params.bodyPreview.slice(0, 120) : null,
    sent_at: null,
    failed_at: null,
    error_message: null,
  };

  const { data, error } = await supabase
    .from("booking_notifications" as never)
    .insert(row)
    .select("id")
    .maybeSingle();

  if (error) {
    // 23505 = unique_violation → a concurrent path already claimed this slot.
    if ((error as { code?: string }).code === "23505") return "skip";
    // Any other error: don't silently drop a real customer notification.
    console.error("[claimNotificationOnce]", safeLogError(error));
    return "unguarded";
  }
  return (data as { id: string } | null)?.id ?? "unguarded";
}

/** Resolve a claimed `sending` row to its final delivery state. */
export async function updateNotificationStatus(
  id: string,
  ok: boolean,
  errorMessage?: string | null,
): Promise<void> {
  await finalizeNotificationClaim(id, {
    status: ok ? "sent" : "failed",
    errorMessage,
  });
}

export type NotificationFinalStatus =
  | "sent"
  | "failed"
  | "suppressed"
  | "unknown";

/**
 * Resolve an atomic claim without overstating provider delivery. `sent` means
 * the provider accepted the request and returned an id; `suppressed` means no
 * provider call was made; and `unknown` is retained when a provider request may
 * have crossed the network boundary but no definitive response came back.
 */
export async function finalizeNotificationClaim(
  id: string,
  params: {
    status: NotificationFinalStatus;
    messageSid?: string | null;
    errorMessage?: string | null;
  },
): Promise<boolean> {
  try {
    const supabase = createServiceRoleClient();
    const now = new Date().toISOString();
    const accepted = params.status === "sent";
    const failed = params.status === "failed";
    const { data, error } = await supabase
      .from("booking_notifications" as never)
      .update({
        status: params.status,
        twilio_message_sid: params.messageSid ?? null,
        sent_at: accepted ? now : null,
        failed_at: failed ? now : null,
        error_message: params.errorMessage ?? null,
      })
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) {
      console.error("[finalizeNotificationClaim]", safeLogError(error));
      return false;
    }
    // PostgREST can return a successful HTTP response after an RLS-filtered or
    // otherwise zero-row update. Durable completion is proven only by the exact
    // claimed row being returned.
    return (data as { id?: unknown } | null)?.id === id;
  } catch (error) {
    console.error("[finalizeNotificationClaim]", safeLogError(error));
    return false;
  }
}

/**
 * Complete a pre-provider review SMS claim. The database acquires the same SID
 * lock as the callback path before exposing the SID, so provider acceptance and
 * an unusually fast StatusCallback cannot deadlock or overwrite one another.
 */
export async function completeReviewRequestSmsNotification(input: {
  notificationId: string;
  status: NotificationFinalStatus;
  providerMessageId?: string | null;
  errorCode?: string | null;
}): Promise<boolean> {
  try {
    const supabase = createServiceRoleClient();
    const { data, error } = await supabase.rpc(
      "complete_review_request_sms_notification" as never,
      {
        p_notification_id: input.notificationId,
        p_status: input.status,
        p_provider_message_id: input.providerMessageId ?? null,
        p_error_code: input.errorCode ?? null,
      } as never,
    );
    if (error) {
      console.error("[completeReviewRequestSmsNotification]", safeLogError(error));
      return false;
    }
    const result = data as unknown as Record<string, unknown> | null;
    return (
      result?.success === true &&
      (result.code === "completed" ||
        result.code === "already_completed" ||
        result.code === "callback_terminal")
    );
  } catch (error) {
    console.error("[completeReviewRequestSmsNotification]", safeLogError(error));
    return false;
  }
}

/** Called by Twilio status webhook to update delivery status. */
export async function updateNotificationBySid(
  messageSid: string,
  status: "delivered" | "undelivered" | "failed",
  errorCode?: string | null,
  notificationId?: string,
): Promise<
  | {
      ok: true;
      code: "applied" | "pending" | "exact_replay" | "durable_conflict";
    }
  | {
      ok: false;
      code:
        | "not_found"
        | "invalid_receipt"
        | "terminal_conflict"
        | "database_error";
    }
> {
  try {
    const supabase = createServiceRoleClient();
    const { data, error } = notificationId
      ? await supabase.rpc(
          "record_twilio_review_request_status_receipt" as never,
          {
            p_notification_id: notificationId,
            p_message_sid: messageSid,
            p_status: status,
            p_error_code: errorCode ?? null,
          } as never,
        )
      : await supabase.rpc(
          "record_twilio_message_status_receipt" as never,
          {
            p_message_sid: messageSid,
            p_status: status,
            p_error_code: errorCode ?? null,
          } as never,
        );
    if (error) {
      console.error("[updateNotificationBySid]", safeLogError(error));
      return { ok: false, code: "database_error" };
    }
    const result = data as unknown as Record<string, unknown> | null;
    if (
      result?.success === true &&
      (result.code === "applied" ||
        result.code === "pending" ||
        result.code === "exact_replay" ||
        result.code === "durable_conflict")
    ) {
      return { ok: true, code: result.code };
    }
    if (result?.code === "invalid_receipt") {
      return { ok: false, code: "invalid_receipt" };
    }
    if (result?.code === "terminal_conflict") {
      return { ok: false, code: "terminal_conflict" };
    }
    return result?.code === "not_found" || result?.code === "invalid_correlation"
      ? { ok: false, code: "not_found" }
      : { ok: false, code: "database_error" };
  } catch (error) {
    console.error("[updateNotificationBySid]", safeLogError(error));
    return { ok: false, code: "database_error" };
  }
}

/** Fetch recent notifications for a salon (for dashboard widget). */
export async function getRecentNotifications(
  salonId: string,
  limit = 30,
) {
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("booking_notifications" as never)
    .select("id, booking_id, notification_type, channel, status, client_phone, body_preview, sent_at, delivered_at, failed_at, created_at")
    .eq("salon_id", salonId)
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data ?? []) as {
    id: string;
    booking_id: string | null;
    notification_type: string;
    channel: string;
    status: string;
    client_phone: string | null;
    body_preview: string | null;
    sent_at: string | null;
    delivered_at: string | null;
    failed_at: string | null;
    created_at: string;
  }[];
}
