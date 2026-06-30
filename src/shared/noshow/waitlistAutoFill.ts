import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { complianceFooterHtml, listUnsubscribeHeaders, isEmailSuppressed } from "@/shared/lib/emailCompliance";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { logNotification } from "@/shared/lib/notificationLog";

const SITE_URL =
  (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";

type WaitlistEntry = {
  id: string;
  client_name: string;
  client_email: string | null;
  client_phone: string;
  claim_token: string | null;
  /** Set by the DB flip when a concrete slot was freed (the assigned staff +
   *  start time). When both are present, the SMS names the staff + time so the
   *  customer knows exactly what they're claiming. */
  offered_staff_id: string | null;
  offered_start_utc: string | null;
  service_name?: string;
  salon_name?: string;
};

/**
 * Build the staff-name + short ASCII time suffix for the waitlist SMS when a
 * concrete slot was freed. Returns `null` (caller keeps the generic body) when
 * either piece is missing/unresolvable. Time is formatted in the SALON
 * timezone, ASCII-only ("2:00 PM") so the body stays a single GSM-7 segment.
 */
async function resolveOfferedSlotCopy(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonId: string,
  offeredStaffId: string | null,
  offeredStartUtc: string | null,
): Promise<{ staffName: string; time: string } | null> {
  if (!offeredStaffId || !offeredStartUtc) return null;
  const startMs = Date.parse(offeredStartUtc);
  if (!Number.isFinite(startMs)) return null;
  try {
    const [{ data: staffRow }, { data: salonRow }] = await Promise.all([
      supabase.from("staff").select("name").eq("id", offeredStaffId).maybeSingle(),
      supabase
        .from("salons")
        .select("timezone")
        .eq("id", salonId)
        .maybeSingle(),
    ]);
    const staffName = String(
      (staffRow as { name?: string | null } | null)?.name ?? "",
    ).trim();
    const timeZone =
      String((salonRow as { timezone?: string | null } | null)?.timezone ?? "").trim() ||
      "UTC";
    if (!staffName) return null;
    const time = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(startMs));
    return { staffName, time };
  } catch (e) {
    console.error("[waitlistAutoFill] resolveOfferedSlotCopy", e);
    return null;
  }
}

/** Resolve the salon's notification language ('en'|'vi') from the canonical
 *  `salons.default_notification_locale` text column (the jsonb
 *  `staff_notification_settings.defaultLocale` is unset on every salon).
 *  Best-effort — any read failure defaults to English. Only governs the auto
 *  opt-out line Twilio appends; the VN-ASCII SMS body itself is fixed. */
async function resolveSalonLang(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonId: string,
): Promise<"en" | "vi"> {
  try {
    const { data } = await supabase
      .from("salons")
      .select("default_notification_locale" as never)
      .eq("id", salonId)
      .maybeSingle();
    const locale = String(
      (data as { default_notification_locale?: unknown } | null)
        ?.default_notification_locale ?? "",
    ).toLowerCase();
    return locale === "vi" ? "vi" : "en";
  } catch {
    return "en";
  }
}

/**
 * Finds the first waiting customer for a freed slot and sends them the claim
 * link. Called after a booking is cancelled, rescheduled, or no-showed — after
 * the DB has already flipped the next FIFO entry to 'notified' + assigned a
 * claim_token.
 *
 * SMS is the PRIMARY channel (every entry has a phone; email is nullable, so a
 * phone-only customer would otherwise get nothing). Email is sent as a bonus
 * when present. Returns `notified:true` if EITHER channel succeeded.
 */
export async function notifyWaitlistForSlot(params: {
  salonId: string;
  salonName: string;
  serviceId: string;
  serviceName: string;
  bookingDateYmd: string;
}): Promise<{ notified: boolean; entryId?: string }> {
  const supabase = createServiceRoleClient();

  // Find the entry that was just marked 'notified' (claim_token IS NOT NULL).
  const { data: entry } = await supabase
    .from("booking_waitlist_entries" as never)
    .select(
      "id, client_name, client_email, client_phone, claim_token, offered_staff_id, offered_start_utc",
    )
    .eq("salon_id", params.salonId)
    .eq("service_id", params.serviceId)
    .eq("status", "notified")
    .not("claim_token", "is", null)
    .order("notified_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!entry) return { notified: false };

  const row = entry as WaitlistEntry;
  if (!row.claim_token) return { notified: false };

  const phone = String(row.client_phone ?? "").trim();
  const email = (row.client_email ?? "").trim();

  // Bail only when there's no way to reach the customer at all.
  if (!phone && !email) return { notified: false };

  let smsOk = false;
  let emailOk = false;

  // PRIMARY — SMS the 20-minute claim link. Same body shape as the manual
  // `inviteWaitlistEntry`: VN ASCII-only → single GSM-7 segment.
  if (phone) {
    const claimUrl = `${SITE_URL}/booking/waitlist-claim?token=${row.claim_token}`;
    // When the DB freed a concrete slot, name the staff + time so the customer
    // knows exactly what they're claiming; else keep the generic body.
    const offered = await resolveOfferedSlotCopy(
      supabase,
      params.salonId,
      row.offered_staff_id,
      row.offered_start_utc,
    );
    const body = offered
      ? `${params.salonName}: Co cho trong ${params.serviceName} ngay ${params.bookingDateYmd} luc ${offered.time} voi ${offered.staffName}. Giu cho trong 20 phut: ${claimUrl}`
      : `${params.salonName}: Co cho trong ${params.serviceName} ngay ${params.bookingDateYmd}. Giu cho trong 20 phut: ${claimUrl}`;
    const lang = await resolveSalonLang(supabase, params.salonId);
    const smsResult = await sendSmsReminder(phone, body, { lang });
    smsOk = smsResult.ok;

    // Log to booking_notifications (booking_id null — no booking yet). Mirrors
    // the manual invite. Best-effort; never let logging mask a real send.
    try {
      await logNotification({
        bookingId: null,
        salonId: params.salonId,
        notificationType: "waitlist_invite",
        channel: "sms",
        clientPhone: phone,
        messageSid: smsResult.messageSid ?? null,
        bodyPreview: body,
        ok: smsResult.ok,
        errorMessage: smsResult.ok ? null : smsResult.error ?? null,
      });
    } catch (e) {
      console.error("[waitlistAutoFill] logNotification", e);
    }
  }

  // BONUS — also email when an address is on file (honours unsubscribe inside).
  if (email) {
    try {
      await sendWaitlistEmail({
        clientName: row.client_name,
        clientEmail: email,
        claimToken: row.claim_token,
        serviceName: params.serviceName,
        salonName: params.salonName,
        bookingDateYmd: params.bookingDateYmd,
      });
      emailOk = true;
    } catch (e) {
      console.error("[waitlistAutoFill] email send failed", e);
    }
  }

  if (!smsOk && !emailOk) return { notified: false };
  return { notified: true, entryId: row.id };
}

async function sendWaitlistEmail(input: {
  clientName: string;
  clientEmail: string;
  claimToken: string;
  serviceName: string;
  salonName: string;
  bookingDateYmd: string;
}): Promise<void> {
  const resend = getResendClient();
  if (!resend) return;

  // Waitlist offers are optional mail → honour unsubscribe.
  if (await isEmailSuppressed(input.clientEmail)) return;

  const claimUrl = `${SITE_URL}/booking/waitlist-claim?token=${input.claimToken}`;
  const from =
    getResendFrom();

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:32px 16px;">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #2a2a2a;border-radius:12px;overflow:hidden;max-width:100%;">
        <tr>
          <td style="background:#1a1a1a;padding:24px 32px;border-bottom:1px solid #2a2a2a;">
            <p style="margin:0;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#c9a96e;">Spot Available</p>
            <h1 style="margin:8px 0 0;font-size:22px;color:#fff;font-weight:normal;">${input.salonName}</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px;">
            <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#d1d1d1;">
              Good news, ${input.clientName}! A spot just opened up for <strong>${input.serviceName}</strong> on ${input.bookingDateYmd}. Claim it before someone else does — this link expires in 20 minutes.
            </p>
            <a href="${claimUrl}" style="display:block;background:#c9a96e;color:#000;text-align:center;padding:14px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:bold;letter-spacing:1px;">
              Claim My Spot →
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;border-top:1px solid #2a2a2a;">
            <p style="margin:0;font-size:11px;color:#555;text-align:center;">First to claim wins · <a href="${SITE_URL}" style="color:#555;">nailiq.ca</a></p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const htmlC = html.replace(
    "</body>",
    `${complianceFooterHtml({ email: input.clientEmail, salonName: input.salonName })}</body>`,
  );
  try {
    await resend.emails.send({
      from,
      to: input.clientEmail,
      subject: `Spot opened: ${input.serviceName} at ${input.salonName}`,
      html: htmlC,
      headers: listUnsubscribeHeaders(input.clientEmail),
    });
  } catch (e) {
    console.error("[waitlistAutoFill] Email send failed", e);
  }
}
