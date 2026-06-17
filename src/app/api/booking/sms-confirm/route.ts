// POST /api/booking/sms-confirm
// Sends bilingual confirmation SMS and tracks delivery status on the booking row.
// Checks customer_preferences for preferred language; defaults to Vietnamese.

import { NextResponse } from "next/server";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { logNotification } from "@/shared/lib/notificationLog";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { sendBookingConfirmationEmail } from "@/shared/booking/sendBookingConfirmationEmail";

export const dynamic = "force-dynamic";

function formatConfirmDate(isoUtc: string): string {
  try {
    return new Date(isoUtc).toLocaleString("en-CA", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Vancouver",
    });
  } catch {
    return isoUtc;
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ ok: false }, { status: 400 });

  const { bookingId, salonId, clientPhone, clientName, serviceName, staffName, startTimeUtc, language, partySize, smsConsent, groupId } =
    body as {
      bookingId?: string;
      salonId?: string;
      clientPhone?: string;
      clientName?: string;
      serviceName?: string;
      staffName?: string;
      startTimeUtc?: string;
      /** Language the customer chose at booking — wins over any stored pref. */
      language?: string | null;
      /** Set (>1) for a GROUP booking → one party-summary message instead of a
       *  per-service line. serviceName is then not required. */
      partySize?: number;
      /** QA BUG-03 — the customer ticked the required SMS-consent box. Stamp
       *  sms_consent_at so we have a CASL/TCPA record. */
      smsConsent?: boolean;
      /** Group id — stamp consent across all the party's bookings. */
      groupId?: string;
    };

  const isGroup = typeof partySize === "number" && partySize > 1;

  if (!bookingId || !salonId || !clientPhone || !startTimeUtc || (!isGroup && !serviceName)) {
    return NextResponse.json({ ok: false, error: "missing_fields" }, { status: 400 });
  }

  const db = createServiceRoleClient();

  // QA BUG-03 — record express SMS consent first, independent of whether the
  // Twilio send below succeeds (the consent record must persist regardless).
  if (smsConsent === true) {
    const nowIso = new Date().toISOString();
    if (groupId) {
      void db.from("bookings").update({ sms_consent_at: nowIso } as never).eq("group_id", groupId);
    } else {
      void db.from("bookings").update({ sms_consent_at: nowIso } as never).eq("id", bookingId);
    }
  }

  // Check if SMS is enabled for this salon
  const { data: salon } = await db
    .from("salons")
    .select("name, slug, subscription_plan, plan_override, address")
    .eq("id", salonId)
    .maybeSingle();

  if (!salon) return NextResponse.json({ ok: false, error: "salon_not_found" }, { status: 404 });

  // Defense-in-depth for the Twilio kill-switch: flag E2E/test salons so
  // sendSmsReminder suppresses real SMS even if a seed number ever slips past
  // the 555-exchange guard. E2E fixtures use slugs prefixed "e2e-" / names
  // starting "E2E " (e.g. "E2E Group Salon") — no real tenant does.
  const salonSlug = (salon as { slug?: string | null }).slug ?? "";
  const salonIsTest =
    /^e2e[-_]/i.test(salonSlug) || /^e2e\b/i.test(salon.name ?? "");

  // Language precedence: the language the customer just chose at booking
  // wins; else their stored preference; else Vietnamese.
  const requestedLang = language === "en" || language === "vi" ? language : null;

  const { data: profile } = await db
    .from("client_profiles")
    .select("id, email")
    .eq("phone", clientPhone)
    .is("deleted_at", null)
    .maybeSingle();
  const clientEmailOnFile = (profile as { email?: string | null } | null)?.email?.trim() || null;

  let lang = requestedLang ?? "vi";
  if (profile) {
    if (requestedLang) {
      // Persist the choice so future reminders for this customer match it.
      await db.from("customer_preferences").upsert(
        {
          client_profile_id: profile.id,
          salon_id: salonId,
          preferred_language: requestedLang,
        },
        { onConflict: "client_profile_id" },
      );
    } else {
      const { data: prefs } = await db
        .from("customer_preferences")
        .select("preferred_language")
        .eq("client_profile_id", profile.id)
        .eq("salon_id", salonId)
        .maybeSingle();
      lang = prefs?.preferred_language ?? "vi";
    }
  }

  const dateStr = formatConfirmDate(startTimeUtc);
  const name = clientName ?? "bạn";
  const salonName = salon.name ?? "";
  const staff = staffName ? ` with ${staffName}` : "";

  const baseMessage = isGroup
    ? lang === "en"
      ? `✅ Group of ${partySize} booked at ${salonName} · ${dateStr}. Reply STOP to opt out.`
      : `✅ Đã đặt lịch nhóm ${partySize} người tại ${salonName} · ${dateStr}. Nhắn STOP để huỷ nhận tin.`
    : lang === "en"
      ? `✅ Booked! ${serviceName}${staff} at ${salonName} · ${dateStr}. Reply STOP to opt out.`
      : `✅ Đã đặt lịch! ${serviceName} tại ${salonName} · ${dateStr}. Nhắn STOP để huỷ nhận tin.`;

  // Append the salon ADDRESS as plain text (not a long Google Maps URL): phones
  // auto-link a street address → tap opens the user's default maps app, and it's
  // far shorter than an encoded maps URL (saves an SMS segment). The full
  // "Get directions" Google button stays in the confirmation EMAIL.
  const salonAddress = (salon as { address?: string | null }).address?.trim() || "";
  const addrLine = salonAddress ? `\n📍 ${salonAddress}` : "";
  const message = baseMessage + addrLine;

  const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
  const statusCallbackUrl = `${SITE_URL}/api/twilio/status`;
  const result = await sendSmsReminder(clientPhone, message, { statusCallbackUrl, salonIsTest, lang: lang === "en" ? "en" : "vi" });

  // Track on bookings row (legacy columns kept for now)
  void db
    .from("bookings")
    .update(
      result.ok
        ? { sms_confirmation_sent_at: new Date().toISOString() }
        : {
            sms_confirmation_failed_at: new Date().toISOString(),
            sms_confirmation_error: result.error ?? "unknown",
          },
    )
    .eq("id", bookingId);

  // Log to central notifications table
  void logNotification({
    bookingId,
    salonId,
    notificationType: "booking_confirmation",
    channel: "sms",
    clientPhone,
    messageSid: result.messageSid,
    bodyPreview: message,
    ok: result.ok,
    errorMessage: result.error,
  });

  // Email confirmation — parallel channel when customer has an email on file
  // and the rich email wasn't already sent by submitPublicBooking (e.g. desk
  // bookings, or online bookings where the customer skipped the email field).
  // Best-effort: never blocks the SMS response.
  if (clientEmailOnFile && !isGroup && serviceName && staffName) {
    void (async () => {
      // Only send if no email confirmation was logged yet for this booking.
      const { count } = await db
        .from("booking_notifications")
        .select("id", { count: "exact", head: true })
        .eq("booking_id", bookingId)
        .eq("notification_type", "booking_confirmation")
        .eq("channel", "email");
      if ((count ?? 0) === 0) {
        await sendBookingConfirmationEmail({
          bookingId,
          shopSlug: salonSlug,
          clientName: clientName ?? "Guest",
          clientEmail: clientEmailOnFile,
          serviceName: serviceName!,
          staffName: staffName!,
          startTimeUtc,
          totalPriceCents: null,
        });
      }
    })();
  }

  return NextResponse.json({ ok: result.ok, error: result.error });
}
