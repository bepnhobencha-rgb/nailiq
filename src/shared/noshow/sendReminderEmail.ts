import Anthropic from "@anthropic-ai/sdk";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { complianceFooterHtml, listUnsubscribeHeaders, isEmailSuppressed } from "@/shared/lib/emailCompliance";
import { trackAnthropicMessage } from "@/shared/ai/usageLedger";

export type ReminderEmailInput = {
  salonId: string;
  tokenId: string;
  clientName: string;
  clientEmail: string;
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
};

const SITE_URL =
  (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";

/** Formats UTC timestamp in the salon's timezone (Pacific only as a fallback). */
function formatAppointmentTime(isoUtc: string, timezone?: string | null): string {
  try {
    return new Date(isoUtc).toLocaleString("en-US", {
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
    const client = new Anthropic({ apiKey: key });
    const formattedTime = formatAppointmentTime(input.startTimeUtc, input.timezone);

    const prompt = `Write a warm, natural appointment reminder message for ${input.businessDescriptor?.trim() || "a salon"}.
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
  } catch {
    // fall through to default
  }

  return defaultBody(input);
}

function defaultBody(input: ReminderEmailInput): string {
  const formattedTime = formatAppointmentTime(input.startTimeUtc, input.timezone);
  return `Hi ${input.clientName}, this is a friendly reminder about your upcoming ${input.serviceName} appointment with ${input.staffName} at ${input.salonName} on ${formattedTime}. We look forward to seeing you!`;
}

function buildEmailHtml(input: ReminderEmailInput, body: string): string {
  const confirmUrl = `${SITE_URL}/booking/confirm?token=${input.tokenId}`;
  const rescheduleUrl = `${SITE_URL}/booking/reschedule?token=${input.tokenId}`;
  const cancelUrl = `${SITE_URL}/booking/cancel?token=${input.tokenId}`;
  const formattedTime = formatAppointmentTime(input.startTimeUtc, input.timezone);

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:32px 16px;">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #2a2a2a;border-radius:12px;overflow:hidden;max-width:100%;">
        <tr>
          <td style="background:#1a1a1a;padding:24px 32px;border-bottom:1px solid #2a2a2a;">
            <p style="margin:0;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#c9a96e;">Appointment Reminder</p>
            <h1 style="margin:8px 0 0;font-size:22px;color:#fff;font-weight:normal;">${input.salonName}</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px;">
            <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#d1d1d1;">${body}</p>
            <table cellpadding="0" cellspacing="0" style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;width:100%;">
              <tr><td style="padding:16px 20px;">
                <p style="margin:0 0 4px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c9a96e;">Your Appointment</p>
                <p style="margin:4px 0;font-size:15px;color:#fff;font-weight:bold;">${input.serviceName}</p>
                <p style="margin:4px 0;font-size:13px;color:#aaa;">with ${input.staffName}</p>
                <p style="margin:8px 0 0;font-size:14px;color:#d1d1d1;">${formattedTime}</p>
              </td></tr>
            </table>
            <table cellpadding="0" cellspacing="0" style="margin-top:24px;width:100%;">
              <tr>
                <td style="padding:0 6px 0 0;">
                  <a href="${confirmUrl}" style="display:block;background:#c9a96e;color:#000;text-align:center;padding:12px 8px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:bold;letter-spacing:1px;">✓ Confirm</a>
                </td>
                <td style="padding:0 3px;">
                  <a href="${rescheduleUrl}" style="display:block;background:#1a1a1a;border:1px solid #3a3a3a;color:#d1d1d1;text-align:center;padding:12px 8px;border-radius:6px;text-decoration:none;font-size:13px;letter-spacing:1px;">↗ Reschedule</a>
                </td>
                <td style="padding:0 0 0 6px;">
                  <a href="${cancelUrl}" style="display:block;background:#1a1a1a;border:1px solid #3a3a3a;color:#888;text-align:center;padding:12px 8px;border-radius:6px;text-decoration:none;font-size:13px;letter-spacing:1px;">✕ Cancel</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;border-top:1px solid #2a2a2a;">
            <p style="margin:0;font-size:11px;color:#555;text-align:center;">Powered by NailIQ · <a href="${SITE_URL}" style="color:#555;">nailiq.ca</a></p>
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
};

export type GroupReminderEmailInput = {
  tokenId: string;
  organizerName: string;
  organizerEmail: string;
  salonName: string;
  salonSlug: string;
  reminderType: "24h" | "3h";
  timezone?: string | null;
  businessDescriptor?: string;
  salonContactEmail?: string | null;
  /** All group members including organizer, ordered by start_time_utc */
  members: GroupMember[];
};

function buildGroupEmailHtml(input: GroupReminderEmailInput): string {
  const confirmUrl    = `${SITE_URL}/booking/confirm?token=${input.tokenId}`;
  const rescheduleUrl = `${SITE_URL}/booking/reschedule?token=${input.tokenId}`;
  const cancelUrl     = `${SITE_URL}/booking/cancel?token=${input.tokenId}`;

  const unconfirmed = input.members.filter((m) => m.status !== "confirmed");
  const allConfirmed = unconfirmed.length === 0;
  const total = input.members.length;

  const whenLabel = input.reminderType === "24h" ? "tomorrow" : "in 3 hours";

  const memberRows = input.members
    .map((m) => {
      const time = formatAppointmentTime(m.startTimeUtc, input.timezone);
      const badge =
        m.status === "confirmed"
          ? `<span style="color:#4caf50;font-size:11px;">✓ Confirmed</span>`
          : `<span style="color:#c9a96e;font-size:11px;">⏳ Needs to confirm</span>`;
      return `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #2a2a2a;color:#d1d1d1;font-size:13px;">${m.name}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #2a2a2a;color:#aaa;font-size:13px;">${m.serviceName}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #2a2a2a;color:#aaa;font-size:12px;">${time.split(",").slice(-1)[0]?.trim() ?? time}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #2a2a2a;">${badge}</td>
        </tr>`;
    })
    .join("");

  const urgencyBanner = allConfirmed
    ? `<p style="margin:0 0 20px;padding:12px 16px;background:#1a2a1a;border:1px solid #2d4a2d;border-radius:6px;font-size:13px;color:#4caf50;">
        ✓ All ${total} members have confirmed. You're all set!
       </p>`
    : `<p style="margin:0 0 20px;padding:12px 16px;background:#2a1a0a;border:1px solid #4a3010;border-radius:6px;font-size:13px;color:#c9a96e;">
        ⚠️ ${unconfirmed.length} of ${total} members haven't confirmed yet —
        please remind them to confirm their spot so the group can be seated together.
       </p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:32px 16px;">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #2a2a2a;border-radius:12px;overflow:hidden;max-width:100%;">
        <tr>
          <td style="background:#1a1a1a;padding:24px 32px;border-bottom:1px solid #2a2a2a;">
            <p style="margin:0;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#c9a96e;">Group Appointment Reminder · Party of ${total}</p>
            <h1 style="margin:8px 0 0;font-size:22px;color:#fff;font-weight:normal;">${input.salonName}</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px;">
            <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#d1d1d1;">
              Hi ${input.organizerName}, your group appointment is <strong style="color:#fff;">${whenLabel}</strong>.
              Here's a summary for your whole party.
            </p>

            ${urgencyBanner}

            <p style="margin:0 0 10px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c9a96e;">Your Party</p>
            <table cellpadding="0" cellspacing="0" style="width:100%;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;overflow:hidden;">
              <tr style="background:#222;">
                <th style="padding:10px 12px;text-align:left;font-size:11px;letter-spacing:1px;color:#888;font-weight:normal;">Name</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;letter-spacing:1px;color:#888;font-weight:normal;">Service</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;letter-spacing:1px;color:#888;font-weight:normal;">Time</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;letter-spacing:1px;color:#888;font-weight:normal;">Status</th>
              </tr>
              ${memberRows}
            </table>

            <table cellpadding="0" cellspacing="0" style="margin-top:24px;width:100%;">
              <tr>
                <td style="padding:0 6px 0 0;">
                  <a href="${confirmUrl}" style="display:block;background:#c9a96e;color:#000;text-align:center;padding:12px 8px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:bold;letter-spacing:1px;">✓ Confirm My Spot</a>
                </td>
                <td style="padding:0 3px;">
                  <a href="${rescheduleUrl}" style="display:block;background:#1a1a1a;border:1px solid #3a3a3a;color:#d1d1d1;text-align:center;padding:12px 8px;border-radius:6px;text-decoration:none;font-size:13px;letter-spacing:1px;">↗ Reschedule</a>
                </td>
                <td style="padding:0 0 0 6px;">
                  <a href="${cancelUrl}" style="display:block;background:#1a1a1a;border:1px solid #3a3a3a;color:#888;text-align:center;padding:12px 8px;border-radius:6px;text-decoration:none;font-size:13px;letter-spacing:1px;">✕ Cancel</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;border-top:1px solid #2a2a2a;">
            <p style="margin:0;font-size:11px;color:#555;text-align:center;">Powered by NailIQ · <a href="${SITE_URL}" style="color:#555;">nailiq.ca</a></p>
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
): Promise<{ ok: boolean; error?: string; messageId?: string }> {
  const resend = getResendClient();
  if (!resend) return { ok: false, error: "resend_not_configured" };

  if (await isEmailSuppressed(input.organizerEmail)) return { ok: true };

  const html = buildGroupEmailHtml(input).replace(
    "</body>",
    `${complianceFooterHtml({ email: input.organizerEmail, salonName: input.salonName })}</body>`,
  );

  const from =
    getResendFrom();

  try {
    const { data, error } = await resend.emails.send({
      from,
      to: input.organizerEmail,
      subject: `Reminder: Group appointment (party of ${input.members.length}) at ${input.salonName}`,
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
 * Best-effort: logs errors but never throws.
 */
export async function sendReminderEmail(
  input: ReminderEmailInput,
): Promise<{ ok: boolean; error?: string; messageId?: string }> {
  const resend = getResendClient();
  if (!resend) {
    console.warn("[sendReminderEmail] Resend not configured — skipping");
    return { ok: false, error: "resend_not_configured" };
  }

  // Reminders are optional/relationship mail → honour unsubscribe.
  if (await isEmailSuppressed(input.clientEmail)) {
    return { ok: true };
  }

  const body = await generateAiBody(input);
  const html = buildEmailHtml(input, body).replace(
    "</body>",
    `${complianceFooterHtml({ email: input.clientEmail, salonName: input.salonName })}</body>`,
  );
  const from =
    getResendFrom();

  try {
    const { data, error } = await resend.emails.send({
      from,
      to: input.clientEmail,
      subject: `Reminder: your ${input.serviceName} at ${input.salonName}`,
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
