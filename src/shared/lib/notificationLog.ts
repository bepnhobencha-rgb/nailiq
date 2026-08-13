/**
 * Central helper for logging outbound SMS/email notifications to
 * `booking_notifications`. Used by all send paths so the owner dashboard
 * and Twilio webhook have a single source of truth.
 *
 * All functions are server-side only (use service role client).
 */

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type NotificationType =
  | "booking_confirmation"
  | "reminder_24h"
  | "reminder_3h"
  | "review_request"
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
  /** Waitlist lead this delivery belongs to (booking_id is still null). */
  waitlistEntryId?: string | null;
  notificationType: NotificationType;
  channel: NotificationChannel;
  clientPhone?: string | null;
  messageSid?: string | null;
  bodyPreview?: string | null;
  /** Pass false when the send failed before a SID was returned. */
  ok: boolean;
  errorMessage?: string | null;
}

/** Insert a notification row. Returns the new row id (used for deferred updates). */
export async function logNotification(
  params: LogNotificationParams,
): Promise<string | null> {
  const supabase = createServiceRoleClient();
  const now = new Date().toISOString();

  const row = {
    booking_id: params.bookingId,
    salon_id: params.salonId,
    waitlist_entry_id: params.waitlistEntryId ?? null,
    notification_type: params.notificationType,
    channel: params.channel,
    status: params.ok ? "sent" : "failed",
    client_phone: params.clientPhone ?? null,
    twilio_message_sid: params.messageSid ?? null,
    body_preview: params.bodyPreview ? params.bodyPreview.slice(0, 120) : null,
    sent_at: params.ok ? now : null,
    failed_at: params.ok ? null : now,
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
    console.error("[logNotification]", error);
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
    waitlist_entry_id: params.waitlistEntryId ?? null,
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
    console.error("[claimNotificationOnce]", error);
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
  const supabase = createServiceRoleClient();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("booking_notifications" as never)
    .update({
      status: ok ? "sent" : "failed",
      sent_at: ok ? now : null,
      failed_at: ok ? null : now,
      error_message: errorMessage ?? null,
    })
    .eq("id", id);
  if (error) console.error("[updateNotificationStatus]", error);
}

/** Called by Twilio status webhook to update delivery status. */
export async function updateNotificationBySid(
  messageSid: string,
  status: "delivered" | "undelivered" | "failed",
  errorCode?: string | null,
): Promise<void> {
  const supabase = createServiceRoleClient();
  const now = new Date().toISOString();

  const patch: Record<string, unknown> = { status };
  if (errorCode) patch.error_code = errorCode;
  if (status === "delivered") patch.delivered_at = now;
  else patch.failed_at = now;

  await supabase
    .from("booking_notifications" as never)
    .update(patch)
    .eq("twilio_message_sid", messageSid);
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
