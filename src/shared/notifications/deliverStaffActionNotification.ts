import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { unsubscribeUrl, listUnsubscribeHeaders } from "@/shared/lib/emailCompliance";
import { logNotification } from "@/shared/lib/notificationLog";
import {
  resolveCustomerLocale,
  type SupportedLocale,
} from "./resolveCustomerLocale";
import {
  buildStaffActionSms,
  buildStaffActionEmailSubject,
} from "./staffActionMessages";
import type { StaffNotifyEvent } from "@/shared/dashboard/staffNotificationSettings";

/**
 * Deliver a staff-action customer notification (create/reschedule/cancel) on
 * the requested channels, in the resolved locale. Pure delivery — best-effort,
 * never throws — so it can run from a service-role context (the cron) or a
 * dashboard action. The booking row is loaded with a SERVICE-ROLE client.
 *
 * Language: online bookings keep the customer's site language
 * (`bookings.client_locale`); staff/desk actions fall back to the salon
 * default (English) — see `resolveCustomerLocale`.
 */
export async function deliverStaffActionNotification(
  supabase: SupabaseClient,
  input: {
    salonId: string;
    bookingId: string;
    event: StaffNotifyEvent;
    channels: { sms?: boolean; email?: boolean };
    localeOverride?: SupportedLocale;
  },
): Promise<{ smsSent: boolean; emailSent: boolean; locale: SupportedLocale }> {
  if (input.event === "no_show") {
    return { smsSent: false, emailSent: false, locale: "en" };
  }

  // `bookings` has TWO FKs to `services` (service_id + addon_service_id) — embed
  // via the FK column or PostgREST errors with "more than one relationship".
  const { data: bk, error: bkErr } = await supabase
    .from("bookings")
    .select(
      "id, client_phone, client_email, client_name, client_locale, start_time_utc, service:service_id(name)",
    )
    .eq("id", input.bookingId)
    .eq("salon_id", input.salonId)
    .maybeSingle();
  if (bkErr || !bk?.id) {
    console.error("[deliverStaffActionNotification] booking load failed", bkErr);
    return { smsSent: false, emailSent: false, locale: "en" };
  }

  const row = bk as unknown as {
    client_phone: string | null;
    client_email: string | null;
    client_name: string | null;
    client_locale: string | null;
    start_time_utc: string;
    service: { name: string | null } | { name: string | null }[] | null;
  };

  const { data: salonRow } = await supabase
    .from("salons")
    .select("name, phone, timezone, default_notification_locale, email_outbound_enabled")
    .eq("id", input.salonId)
    .maybeSingle();
  const salon = (salonRow ?? {}) as {
    name?: string | null;
    phone?: string | null;
    timezone?: string | null;
    default_notification_locale?: string | null;
    email_outbound_enabled?: boolean | null;
  };
  const emailOutboundEnabled = salon.email_outbound_enabled !== false;

  const locale: SupportedLocale =
    input.localeOverride ??
    resolveCustomerLocale({
      clientLocale: row.client_locale,
      salonDefaultLocale: salon.default_notification_locale,
    });

  const serviceName = Array.isArray(row.service)
    ? (row.service[0]?.name ?? "")
    : (row.service?.name ?? "");

  const whenLabel = new Intl.DateTimeFormat(
    locale === "vi" ? "vi-VN" : "en-US",
    {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: salon.timezone || "America/Los_Angeles",
    },
  ).format(new Date(Date.parse(row.start_time_utc)));

  const vars = {
    customerName: (row.client_name ?? "").trim(),
    salonName: salon.name || "",
    serviceName,
    whenLabel,
    salonPhone: salon.phone,
  };

  let smsSent = false;
  let emailSent = false;

  if (input.channels.sms && row.client_phone) {
    const body = buildStaffActionSms(input.event, locale, vars);
    if (body) {
      try {
        const r = await sendSmsReminder(row.client_phone, body, { lang: locale === "en" ? "en" : "vi" });
        smsSent = r.ok;
        void logNotification({
          bookingId: input.bookingId,
          salonId: input.salonId,
          notificationType: "booking_confirmation",
          channel: "sms",
          clientPhone: row.client_phone,
          messageSid: r.messageSid,
          bodyPreview: body,
          ok: r.ok,
          errorMessage: r.error,
        });
      } catch (e) {
        console.error("[deliverStaffActionNotification] sms", e);
      }
    }
  }

  if (emailOutboundEnabled && input.channels.email && row.client_email) {
    const subject = buildStaffActionEmailSubject(input.event, locale, vars.salonName);
    const body = buildStaffActionSms(input.event, locale, vars);
    const client = getResendClient();
    if (subject && body && client) {
      const to = row.client_email;
      const footer =
        locale === "en"
          ? `\n\n— ${vars.salonName}\nUnsubscribe: ${unsubscribeUrl(to)}`
          : `\n\n— ${vars.salonName}\nNgừng nhận email: ${unsubscribeUrl(to)}`;
      try {
        const res = await client.emails.send({
          from: getResendFrom(),
          to,
          subject,
          text: body + footer,
          headers: listUnsubscribeHeaders(to),
        });
        emailSent = !res.error;
        void logNotification({
          bookingId: input.bookingId,
          salonId: input.salonId,
          notificationType: "booking_confirmation",
          channel: "email",
          clientPhone: to,
          messageSid: res.data?.id,
          bodyPreview: subject,
          ok: emailSent,
          errorMessage: res.error ? String(res.error) : null,
        });
      } catch (e) {
        console.error("[deliverStaffActionNotification] email", e);
      }
    }
  }

  return { smsSent, emailSent, locale };
}
