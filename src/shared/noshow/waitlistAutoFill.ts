import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { buildEmailExperience } from "@/shared/lib/emailExperience";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { logNotification } from "@/shared/lib/notificationLog";
import { buildWaitlistSms } from "@/shared/lib/smsTemplateRegistry";

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
      supabase
        .from("staff")
        .select("name")
        .eq("id", offeredStaffId)
        .maybeSingle(),
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
      String(
        (salonRow as { timezone?: string | null } | null)?.timezone ?? "",
      ).trim() || "UTC";
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
  // Scope by booking_date too: a busy salon can hold several concurrently
  // 'notified' entries for the same service across different dates (freed slots
  // from cancel / reschedule / no-show / group late-decline paths all flip an
  // entry to 'notified'). Without the date filter this fetched the OLDEST such
  // entry — re-SMSing an already-notified customer with the WRONG date while the
  // person the caller actually just promoted got nothing. Order newest-first so
  // we grab the entry the DB just flipped, not a stale one still in its window.
  const { data: entry } = await supabase
    .from("booking_waitlist_entries" as never)
    .select(
      "id, client_name, client_email, client_phone, claim_token, offered_staff_id, offered_start_utc",
    )
    .eq("salon_id", params.salonId)
    .eq("service_id", params.serviceId)
    .eq("booking_date", params.bookingDateYmd)
    .eq("status", "notified")
    .not("claim_token", "is", null)
    .order("notified_at", { ascending: false })
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
    const lang = await resolveSalonLang(supabase, params.salonId);
    const detail = offered
      ? `${params.bookingDateYmd} · ${offered.time} · ${offered.staffName}`
      : params.bookingDateYmd;
    const body = buildWaitlistSms({
      lang,
      salonName: params.salonName,
      serviceName: params.serviceName,
      detail,
      claimUrl,
    });
    const smsResult = await sendSmsReminder(phone, body, {
      salonId: params.salonId,
      lang,
      notificationType: "waitlist_invite",
    });
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
        deliveryStatus: smsResult.outcome === "accepted"
          ? "sent"
          : smsResult.outcome === "suppressed"
            ? "suppressed"
            : smsResult.outcome === "unknown"
              ? "unknown"
              : "failed",
        errorMessage: smsResult.ok ? null : (smsResult.error ?? null),
      });
    } catch (e) {
      console.error("[waitlistAutoFill] logNotification", e);
    }
  }

  // Email is the dependable delivery channel for public waitlist entries.
  // Link-bearing SMS can be filtered by carriers, so a failed email must not
  // be reported as a successful notification.
  if (email) {
    try {
      emailOk = await sendWaitlistEmail({
        clientName: row.client_name,
        clientEmail: email,
        claimToken: row.claim_token,
        serviceName: params.serviceName,
        salonName: params.salonName,
        bookingDateYmd: params.bookingDateYmd,
      });
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
}): Promise<boolean> {
  const resend = getResendClient();
  if (!resend) return false;

  const claimUrl = `${SITE_URL}/booking/waitlist-claim?token=${encodeURIComponent(input.claimToken)}`;
  const from = getResendFrom();
  const experience = buildEmailExperience({
    key: "waitlist_offer_legacy",
    locale: "en",
    subject: `Spot opened: ${input.serviceName} at ${input.salonName}`,
    preheader: "A requested time opened. Claim it within 20 minutes.",
    salonName: input.salonName,
    recipientEmail: input.clientEmail,
    badge: "SPOT AVAILABLE",
    greeting: `Good news, ${input.clientName}!`,
    heading: "A time you wanted just opened",
    paragraphs: ["NailIQ matched this opening against the salon's current schedule."],
    details: [
      { label: "Service", value: input.serviceName },
      { label: "Date", value: input.bookingDateYmd },
    ],
    callout: {
      title: "First confirmed claim wins",
      body: "This is an invitation, not a booking. Your appointment exists only after the claim is confirmed.",
    },
    actions: [{ label: "Claim my spot", url: claimUrl }],
    note: "This secure link expires in 20 minutes.",
  });
  try {
    const { error } = await resend.emails.send({
      from,
      to: input.clientEmail,
      subject: `Spot opened: ${input.serviceName} at ${input.salonName}`,
      html: experience.html,
      text: experience.text,
      headers: experience.headers,
      tags: experience.tags,
    });
    if (error) {
      console.error("[waitlistAutoFill] Email send failed", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[waitlistAutoFill] Email send failed", e);
    return false;
  }
}
