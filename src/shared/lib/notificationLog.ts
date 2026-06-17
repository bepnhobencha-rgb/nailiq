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
    console.error("[logNotification]", error);
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}

/** Called by Twilio status webhook to update delivery status. */
export async function updateNotificationBySid(
  messageSid: string,
  status: "delivered" | "undelivered" | "failed",
): Promise<void> {
  const supabase = createServiceRoleClient();
  const now = new Date().toISOString();

  const patch: Record<string, unknown> = { status };
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
