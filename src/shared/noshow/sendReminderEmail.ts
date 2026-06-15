import Anthropic from "@anthropic-ai/sdk";
import { getResendClient } from "@/shared/lib/resend";
import { complianceFooterHtml, listUnsubscribeHeaders, isEmailSuppressed } from "@/shared/lib/emailCompliance";

export type ReminderEmailInput = {
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

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    });

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

/**
 * Sends a personalized reminder email with AI-written body and one-tap action links.
 * Best-effort: logs errors but never throws.
 */
export async function sendReminderEmail(
  input: ReminderEmailInput,
): Promise<{ ok: boolean; error?: string }> {
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
    (process.env.RESEND_FROM ?? "").trim() ||
    `${input.salonName} <noreply@nailiq.ca>`;

  try {
    const { error } = await resend.emails.send({
      from,
      to: input.clientEmail,
      subject: `Reminder: your ${input.serviceName} at ${input.salonName}`,
      html,
      headers: listUnsubscribeHeaders(input.clientEmail),
    });

    if (error) {
      console.error("[sendReminderEmail] Resend error", error);
      return { ok: false, error: String(error) };
    }
    return { ok: true };
  } catch (e) {
    console.error("[sendReminderEmail] Unexpected error", e);
    return { ok: false, error: String(e) };
  }
}
