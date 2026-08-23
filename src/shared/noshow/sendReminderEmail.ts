import { createTextBackgroundAnthropicClient } from "@/shared/ai/anthropicProviderPolicy";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { complianceFooterHtml, listUnsubscribeHeaders, isEmailSuppressed } from "@/shared/lib/emailCompliance";
import {
  isProviderTimeoutError,
  trackAnthropicMessage,
} from "@/shared/ai/usageLedger";
import {
  buildEmailBrandHeader,
  escapeEmailHtml,
  normalizeEmailLocale,
  type EmailLocale,
} from "@/shared/booking/emailBranding";

export type ReminderEmailInput = {
  salonId: string;
  confirmToken: string;
  rescheduleToken: string;
  cancelToken: string;
  clientName: string;
  clientEmail: string;
  locale?: EmailLocale | null;
  serviceName: string;
  staffName: string;
  startTimeUtc: string;
  salonName: string;
  salonSlug: string;
  /** Salon IANA timezone — the appointment time is shown in this zone.
   *  Falls back to America/Los_Angeles when unset. No hardcode per salon. */
  timezone?: string | null;
  /** Vertical AI descriptor (e.g. "a head spa…") for the reminder wording —
   *  replaces the old hardcoded "a nail salon". */
  businessDescriptor?: string;
  /** Salon owner/booking email for Reply-To header. When the customer hits
   *  Reply the message lands at the salon, not noreply@nailiq.ca. */
  salonContactEmail?: string | null;
  /** Public salon logo. The shared renderer accepts HTTPS only. */
  salonLogoUrl?: string | null;
};

const SITE_URL =
  (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";

export function buildReminderEmailSubject(input: Pick<
  ReminderEmailInput,
  "locale" | "serviceName" | "salonName"
>): string {
  return normalizeEmailLocale(input.locale) === "vi"
    ? `Nhắc lịch: ${input.serviceName} tại ${input.salonName}`
    : `Reminder: your ${input.serviceName} at ${input.salonName}`;
}

export function buildGroupReminderEmailSubject(input: Pick<
  GroupReminderEmailInput,
  "locale" | "members" | "salonName"
>): string {
  return normalizeEmailLocale(input.locale) === "vi"
    ? `Nhắc lịch: Lịch hẹn nhóm (${input.members.length} người) tại ${input.salonName}`
    : `Reminder: Group appointment (party of ${input.members.length}) at ${input.salonName}`;
}

/** Formats UTC timestamp in the salon's timezone (Pacific only as a fallback). */
function formatAppointmentTime(
  isoUtc: string,
  timezone: string | null | undefined,
  locale: EmailLocale,
): string {
  try {
    return new Date(isoUtc).toLocaleString(locale === "vi" ? "vi-VN" : "en-US", {
      timeZone: (timezone && timezone.trim()) || "America/Los_Angeles",
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return isoUtc;
  }
}

async function generateAiBody(input: ReminderEmailInput): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return defaultBody(input);

  try {
    const client = createTextBackgroundAnthropicClient(key);
    const locale = normalizeEmailLocale(input.locale);
    const formattedTime = formatAppointmentTime(input.startTimeUtc, input.timezone, locale);

    const prompt = `${locale === "vi" ? "Viết bằng tiếng Việt một lời nhắc lịch hẹn tự nhiên, ấm áp" : "Write a warm, natural appointment reminder message"} for ${input.businessDescriptor?.trim() || "a salon"}.
Keep it under 3 sentences. Friendly but professional. No emojis.

Details:
- Customer: ${input.clientName}
- Service: ${input.serviceName}
- Technician: ${input.staffName}
- Time: ${formattedTime}
- Salon: ${input.salonName}

Only output the message text, nothing else.`;

    const model = "claude-haiku-4-5-20251001";
    const response = await trackAnthropicMessage(
      { salonId: input.salonId, feature: "reminder_email", model },
      () =>
        client.messages.create({
          model,
          max_tokens: 150,
          messages: [{ role: "user", content: prompt }],
        }),
    );

    if (response.content[0].type === "text") {
      return response.content[0].text.trim();
    }
  } catch (error) {
    if (isProviderTimeoutError(error)) throw error;
    // fall through to default
  }

  return defaultBody(input);
}

function defaultBody(input: ReminderEmailInput): string {
  const locale = normalizeEmailLocale(input.locale);
  const formattedTime = formatAppointmentTime(input.startTimeUtc, input.timezone, locale);
  return locale === "vi"
    ? `Chào ${input.clientName}, đây là lời nhắc thân thiện về lịch hẹn ${input.serviceName} với ${input.staffName} tại ${input.salonName} vào ${formattedTime}. Hẹn gặp bạn!`
    : `Hi ${input.clientName}, this is a friendly reminder about your upcoming ${input.serviceName} appointment with ${input.staffName} at ${input.salonName} on ${formattedTime}. We look forward to seeing you!`;
}

export function buildReminderEmailHtml(input: ReminderEmailInput, body: string): string {
  const locale = normalizeEmailLocale(input.locale);
  const copy = locale === "vi"
    ? { subtitle: "Nhắc lịch hẹn", appointment: "Lịch hẹn của bạn", with: "với", confirm: "✓ Xác nhận", reschedule: "↗ Dời lịch", cancel: "✕ Huỷ lịch", powered: "Được hỗ trợ bởi" }
    : { subtitle: "Appointment Reminder", appointment: "Your Appointment", with: "with", confirm: "✓ Confirm", reschedule: "↗ Reschedule My Spot", cancel: "✕ Cancel My Spot", powered: "Powered by" };
  const confirmUrl = `${SITE_URL}/booking/confirm?token=${encodeURIComponent(input.confirmToken)}`;
  const rescheduleUrl = `${SITE_URL}/booking/reschedule?token=${encodeURIComponent(input.rescheduleToken)}`;
  const cancelUrl = `${SITE_URL}/booking/cancel?token=${encodeURIComponent(input.cancelToken)}`;
  const formattedTime = formatAppointmentTime(input.startTimeUtc, input.timezone, locale);

  return `<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:32px 16px;">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #2a2a2a;border-radius:12px;overflow:hidden;max-width:100%;">
        <tr>
          <td style="background:#1a1a1a;padding:24px 32px;border-bottom:1px solid #2a2a2a;">
            ${buildEmailBrandHeader({ salonName: input.salonName, logoUrl: input.salonLogoUrl, subtitle: copy.subtitle })}
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px;">
            <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#d1d1d1;">${escapeEmailHtml(body)}</p>
            <table cellpadding="0" cellspacing="0" style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;width:100%;">
              <tr><td style="padding:16px 20px;">
                <p style="margin:0 0 4px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c9a96e;">${copy.appointment}</p>
                <p style="margin:4px 0;font-size:15px;color:#fff;font-weight:bold;">${escapeEmailHtml(input.serviceName)}</p>
                <p style="margin:4px 0;font-size:13px;color:#aaa;">${copy.with} ${escapeEmailHtml(input.staffName)}</p>
                <p style="margin:8px 0 0;font-size:14px;color:#d1d1d1;">${escapeEmailHtml(formattedTime)}</p>
              </td></tr>
            </table>
            <table cellpadding="0" cellspacing="0" style="margin-top:24px;width:100%;">
              <tr>
                <td style="padding:0 6px 0 0;">
                  <a href="${confirmUrl}" style="display:block;background:#c9a96e;color:#000;text-align:center;padding:12px 8px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:bold;letter-spacing:1px;">${copy.confirm}</a>
                </td>
                <td style="padding:0 3px;">
                  <a href="${rescheduleUrl}" style="display:block;background:#1a1a1a;border:1px solid #3a3a3a;color:#d1d1d1;text-align:center;padding:12px 8px;border-radius:6px;text-decoration:none;font-size:13px;letter-spacing:1px;">${copy.reschedule}</a>
                </td>
                <td style="padding:0 0 0 6px;">
                  <a href="${cancelUrl}" style="display:block;background:#1a1a1a;border:1px solid #3a3a3a;color:#888;text-align:center;padding:12px 8px;border-radius:6px;text-decoration:none;font-size:13px;letter-spacing:1px;">${copy.cancel}</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;border-top:1px solid #2a2a2a;">
            <p style="margin:0;font-size:11px;color:#555;text-align:center;">${copy.powered} NailIQ · <a href="${SITE_URL}" style="color:#555;">nailiq.ca</a></p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Group Reminder ──────────────────────────────────────────────────────────

export type GroupMember = {
  name: string;
  serviceName: string;
  staffName: string;
  startTimeUtc: string;
  status: "pending" | "confirmed" | string;
  /** Own email distinct from organizer → gets their own individual reminder too */
  email?: string | null;
  /** This member's OWN booking id — the individual reminder's confirm/reschedule/
   *  cancel links must act on this, not the organizer's booking. */
  bookingId?: string;
  locale?: EmailLocale | null;
};

export type GroupReminderEmailInput = {
  confirmToken: string;
  rescheduleToken: string;
  cancelToken: string;
  organizerName: string;
  organizerEmail: string;
  locale?: EmailLocale | null;
  salonName: string;
  salonSlug: string;
  reminderType: "24h" | "3h";
  timezone?: string | null;
  businessDescriptor?: string;
  salonContactEmail?: string | null;
  salonLogoUrl?: string | null;
  /** All group members including organizer, ordered by start_time_utc */
  members: GroupMember[];
};

export function buildGroupReminderEmailHtml(input: GroupReminderEmailInput): string {
  const locale = normalizeEmailLocale(input.locale);
  const vi = locale === "vi";
  const copy = vi
    ? {
        subtitle: `Nhắc lịch hẹn nhóm · ${input.members.length} người`, tomorrow: "ngày mai", hours: "trong 3 giờ",
        hi: "Chào", intro: "lịch hẹn nhóm của bạn diễn ra", summary: "Đây là tóm tắt cho cả nhóm.",
        allConfirmed: "Tất cả thành viên đã xác nhận. Nhóm của bạn đã sẵn sàng!",
        needsConfirm: "thành viên chưa xác nhận — vui lòng nhắc họ xác nhận chỗ.",
        party: "Nhóm của bạn", name: "Tên", service: "Dịch vụ", time: "Giờ", status: "Trạng thái",
        confirmed: "✓ Đã xác nhận", pending: "⏳ Cần xác nhận", confirm: "✓ Xác nhận chỗ của tôi",
        reschedule: "↗ Dời lịch của tôi", cancel: "✕ Huỷ lịch của tôi", powered: "Được hỗ trợ bởi",
      }
    : {
        subtitle: `Group Appointment Reminder · Party of ${input.members.length}`, tomorrow: "tomorrow", hours: "in 3 hours",
        hi: "Hi", intro: "your group appointment is", summary: "Here's a summary for your whole party.",
        allConfirmed: "All members have confirmed. You're all set!",
        needsConfirm: "members haven't confirmed yet — please remind them to confirm their spot.",
        party: "Your Party", name: "Name", service: "Service", time: "Time", status: "Status",
        confirmed: "✓ Confirmed", pending: "⏳ Needs to confirm", confirm: "✓ Confirm My Spot",
        reschedule: "↗ Reschedule My Spot", cancel: "✕ Cancel My Spot", powered: "Powered by",
      };
  const confirmUrl = `${SITE_URL}/booking/confirm?token=${encodeURIComponent(input.confirmToken)}`;
  const rescheduleUrl = `${SITE_URL}/booking/reschedule?token=${encodeURIComponent(input.rescheduleToken)}`;
  const cancelUrl = `${SITE_URL}/booking/cancel?token=${encodeURIComponent(input.cancelToken)}`;

  const unconfirmed = input.members.filter((m) => m.status !== "confirmed");
  const allConfirmed = unconfirmed.length === 0;
  const total = input.members.length;

  const whenLabel = input.reminderType === "24h" ? copy.tomorrow : copy.hours;

  const memberRows = input.members
    .map((m) => {
      const time = formatAppointmentTime(m.startTimeUtc, input.timezone, locale);
      const badge =
        m.status === "confirmed"
          ? `<span style="color:#4caf50;font-size:11px;">${copy.confirmed}</span>`
          : `<span style="color:#c9a96e;font-size:11px;">${copy.pending}</span>`;
      return `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #2a2a2a;color:#d1d1d1;font-size:13px;">${escapeEmailHtml(m.name)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #2a2a2a;color:#aaa;font-size:13px;">${escapeEmailHtml(m.serviceName)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #2a2a2a;color:#aaa;font-size:12px;">${escapeEmailHtml(time.split(",").slice(-1)[0]?.trim() ?? time)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #2a2a2a;">${badge}</td>
        </tr>`;
    })
    .join("");

  const urgencyBanner = allConfirmed
    ? `<p style="margin:0 0 20px;padding:12px 16px;background:#1a2a1a;border:1px solid #2d4a2d;border-radius:6px;font-size:13px;color:#4caf50;">
        ✓ ${copy.allConfirmed}
       </p>`
    : `<p style="margin:0 0 20px;padding:12px 16px;background:#2a1a0a;border:1px solid #4a3010;border-radius:6px;font-size:13px;color:#c9a96e;">
        ⚠️ ${unconfirmed.length}/${total} ${copy.needsConfirm}
       </p>`;

  return `<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:32px 16px;">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #2a2a2a;border-radius:12px;overflow:hidden;max-width:100%;">
        <tr>
          <td style="background:#1a1a1a;padding:24px 32px;border-bottom:1px solid #2a2a2a;">
            ${buildEmailBrandHeader({ salonName: input.salonName, logoUrl: input.salonLogoUrl, subtitle: copy.subtitle })}
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px;">
            <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#d1d1d1;">
              ${copy.hi} ${escapeEmailHtml(input.organizerName)}, ${copy.intro} <strong style="color:#fff;">${whenLabel}</strong>.
              ${copy.summary}
            </p>

            ${urgencyBanner}

            <p style="margin:0 0 10px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c9a96e;">${copy.party}</p>
            <table cellpadding="0" cellspacing="0" style="width:100%;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;overflow:hidden;">
              <tr style="background:#222;">
                <th style="padding:10px 12px;text-align:left;font-size:11px;letter-spacing:1px;color:#888;font-weight:normal;">${copy.name}</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;letter-spacing:1px;color:#888;font-weight:normal;">${copy.service}</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;letter-spacing:1px;color:#888;font-weight:normal;">${copy.time}</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;letter-spacing:1px;color:#888;font-weight:normal;">${copy.status}</th>
              </tr>
              ${memberRows}
            </table>

            <table cellpadding="0" cellspacing="0" style="margin-top:24px;width:100%;">
              <tr>
                <td style="padding:0 6px 0 0;">
                  <a href="${confirmUrl}" style="display:block;background:#c9a96e;color:#000;text-align:center;padding:12px 8px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:bold;letter-spacing:1px;">${copy.confirm}</a>
                </td>
                <td style="padding:0 3px;">
                  <a href="${rescheduleUrl}" style="display:block;background:#1a1a1a;border:1px solid #3a3a3a;color:#d1d1d1;text-align:center;padding:12px 8px;border-radius:6px;text-decoration:none;font-size:13px;letter-spacing:1px;">${copy.reschedule}</a>
                </td>
                <td style="padding:0 0 0 6px;">
                  <a href="${cancelUrl}" style="display:block;background:#1a1a1a;border:1px solid #3a3a3a;color:#888;text-align:center;padding:12px 8px;border-radius:6px;text-decoration:none;font-size:13px;letter-spacing:1px;">${copy.cancel}</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;border-top:1px solid #2a2a2a;">
            <p style="margin:0;font-size:11px;color:#555;text-align:center;">${copy.powered} NailIQ · <a href="${SITE_URL}" style="color:#555;">nailiq.ca</a></p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Sends a consolidated group reminder to the organizer showing all members and
 * flagging any who haven't confirmed. Also sends individual reminders to members
 * who have their own distinct email.
 */
export async function sendGroupReminderEmail(
  input: GroupReminderEmailInput,
): Promise<{
  ok: boolean;
  error?: string;
  messageId?: string;
  suppressed?: boolean;
  suppressionReason?: string;
}> {
  const resend = getResendClient();
  if (!resend) return { ok: false, error: "resend_not_configured" };

  if (await isEmailSuppressed(input.organizerEmail)) {
    return {
      ok: true,
      suppressed: true,
      suppressionReason: "email_opt_out",
    };
  }

  const html = buildGroupReminderEmailHtml(input).replace(
    "</body>",
    `${complianceFooterHtml({ email: input.organizerEmail, salonName: input.salonName, lang: normalizeEmailLocale(input.locale) })}</body>`,
  );

  const from =
    getResendFrom();

  try {
    const { data, error } = await resend.emails.send({
      from,
      to: input.organizerEmail,
      subject: buildGroupReminderEmailSubject(input),
      html,
      headers: listUnsubscribeHeaders(input.organizerEmail),
      ...(input.salonContactEmail ? { replyTo: input.salonContactEmail } : {}),
    });
    if (error) {
      console.error("[sendGroupReminderEmail] Resend error", error);
      return { ok: false, error: String(error) };
    }
    return { ok: true, messageId: data?.id };
  } catch (e) {
    console.error("[sendGroupReminderEmail] Unexpected error", e);
    return { ok: false, error: String(e) };
  }
}

// ─── Individual Reminder ─────────────────────────────────────────────────────

/**
 * Sends a personalized reminder email with AI-written body and one-tap action links.
 * Best-effort for ordinary failures. Provider timeouts fail closed before the
 * Resend call so an incomplete AI attempt cannot trigger downstream delivery.
 */
export async function sendReminderEmail(
  input: ReminderEmailInput,
): Promise<{
  ok: boolean;
  error?: string;
  messageId?: string;
  suppressed?: boolean;
  suppressionReason?: string;
}> {
  const resend = getResendClient();
  if (!resend) {
    console.warn("[sendReminderEmail] Resend not configured — skipping");
    return { ok: false, error: "resend_not_configured" };
  }

  // Reminders are optional/relationship mail → honour unsubscribe.
  if (await isEmailSuppressed(input.clientEmail)) {
    return {
      ok: true,
      suppressed: true,
      suppressionReason: "email_opt_out",
    };
  }

  const body = await generateAiBody(input);
  const html = buildReminderEmailHtml(input, body).replace(
    "</body>",
    `${complianceFooterHtml({ email: input.clientEmail, salonName: input.salonName, lang: normalizeEmailLocale(input.locale) })}</body>`,
  );
  const from =
    getResendFrom();

  try {
    const { data, error } = await resend.emails.send({
      from,
      to: input.clientEmail,
      subject: buildReminderEmailSubject(input),
      html,
      headers: listUnsubscribeHeaders(input.clientEmail),
      ...(input.salonContactEmail ? { replyTo: input.salonContactEmail } : {}),
    });

    if (error) {
      console.error("[sendReminderEmail] Resend error", error);
      return { ok: false, error: String(error) };
    }
    return { ok: true, messageId: data?.id };
  } catch (e) {
    console.error("[sendReminderEmail] Unexpected error", e);
    return { ok: false, error: String(e) };
  }
}
