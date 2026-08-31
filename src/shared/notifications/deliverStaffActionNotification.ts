import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import {
  listUnsubscribeHeaders,
  transactionalEmailSuppressionReason,
} from "@/shared/lib/emailCompliance";
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
import {
  buildCustomerAppointmentEmail,
  customerEmailSiteUrl,
} from "@/shared/notifications/staffActionEmailTemplate";

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
      "id, client_phone, client_email, client_name, client_locale, start_time_utc, service:service_id(name), staff:staff_id(name)",
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
    staff: { name: string | null } | { name: string | null }[] | null;
  };

  const { data: salonRow } = await supabase
    .from("salons")
    .select("name, slug, phone, timezone, default_notification_locale, email_outbound_enabled, logo_url")
    .eq("id", input.salonId)
    .maybeSingle();
  const salon = (salonRow ?? {}) as {
    name?: string | null;
    slug?: string | null;
    phone?: string | null;
    timezone?: string | null;
    default_notification_locale?: string | null;
    email_outbound_enabled?: boolean | null;
    logo_url?: string | null;
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
  const staffName = Array.isArray(row.staff)
    ? (row.staff[0]?.name ?? "")
    : (row.staff?.name ?? "");

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
    staffName,
  };

  let smsSent = false;
  let emailSent = false;

  if (input.channels.sms && row.client_phone) {
    const body = buildStaffActionSms(input.event, locale, vars);
    if (body) {
      try {
        const r = await sendSmsReminder(row.client_phone, body, {
          salonId: input.salonId,
          lang: locale === "en" ? "en" : "vi",
        });
        smsSent = r.ok;
        void logNotification({
          bookingId: input.bookingId,
          salonId: input.salonId,
          notificationType: "staff_action",
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
      // Booking change notifications are transactional — no opt-out gate — but
      // do skip suppressed addresses (hard bounces / spam complaints).
      const suppressed = await transactionalEmailSuppressionReason(
        input.salonId,
        to,
      )
        .then(Boolean)
        .catch(() => true);
      if (!suppressed) {
        const email = buildCustomerAppointmentEmail({
          event: input.event,
          locale,
          subject,
          recipientEmail: to,
          clientName: vars.customerName,
          salonName: vars.salonName,
          salonSlug: salon.slug,
          salonLogoUrl: salon.logo_url,
          salonPhone: salon.phone,
          serviceName: vars.serviceName,
          staffName: vars.staffName,
          whenLabel,
          siteUrl: customerEmailSiteUrl(),
        });
        if (!email) return { smsSent, emailSent, locale };
        try {
          const res = await client.emails.send({
            from: getResendFrom(),
            to,
            subject,
            html: email.html,
            text: email.text,
            headers: listUnsubscribeHeaders(to),
          });
          emailSent = !res.error;
          void logNotification({
            bookingId: input.bookingId,
            salonId: input.salonId,
            notificationType: "staff_action",
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
  }

  return { smsSent, emailSent, locale };
}
