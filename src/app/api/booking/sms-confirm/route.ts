// POST /api/booking/sms-confirm
// Sends bilingual confirmation SMS and tracks delivery status on the booking row.
// Checks customer_preferences for preferred language; defaults to Vietnamese.

import { NextResponse } from "next/server";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { logNotification } from "@/shared/lib/notificationLog";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

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

  const { bookingId, salonId, clientPhone, clientName, serviceName, staffName, startTimeUtc, language } =
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
    };

  if (!bookingId || !salonId || !clientPhone || !serviceName || !startTimeUtc) {
    return NextResponse.json({ ok: false, error: "missing_fields" }, { status: 400 });
  }

  const db = createServiceRoleClient();

  // Check if SMS is enabled for this salon
  const { data: salon } = await db
    .from("salons")
    .select("name, subscription_plan, plan_override")
    .eq("id", salonId)
    .maybeSingle();

  if (!salon) return NextResponse.json({ ok: false, error: "salon_not_found" }, { status: 404 });

  // Language precedence: the language the customer just chose at booking
  // wins; else their stored preference; else Vietnamese.
  const requestedLang = language === "en" || language === "vi" ? language : null;

  const { data: profile } = await db
    .from("client_profiles")
    .select("id")
    .eq("phone", clientPhone)
    .is("deleted_at", null)
    .maybeSingle();

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

  const message =
    lang === "en"
      ? `✅ Booked! ${serviceName}${staff} at ${salonName} · ${dateStr}. Reply STOP to opt out.`
      : `✅ Đã đặt lịch! ${serviceName} tại ${salonName} · ${dateStr}. Nhắn STOP để huỷ nhận tin.`;

  const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
  const statusCallbackUrl = `${SITE_URL}/api/twilio/status`;
  const result = await sendSmsReminder(clientPhone, message, { statusCallbackUrl });

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

  return NextResponse.json({ ok: result.ok, error: result.error });
}
