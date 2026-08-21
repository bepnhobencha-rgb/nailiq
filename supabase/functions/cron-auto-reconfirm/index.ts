// Supabase Edge Function — cron-auto-reconfirm
// Runs daily at 08:00 UTC.
// POST { salon_id?: string }
//
// For bookings 24-48 hours away that have NOT been confirmed by SMS,
// sends a re-confirmation SMS. Only for salons with SMS reminders enabled.
// Marks bookings with reconfirm_sent_at to avoid double-sending.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  outboundMessageLimit,
  outboundMessagingEnabled,
  rejectUnauthorizedInternalRequest,
} from "../_shared/internalAuth.ts";
import { supabaseSecretKey } from "../_shared/supabaseApiKeys.ts";
import { requireSmsConsentClear } from "../_shared/smsConsentSuppression.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = supabaseSecretKey();

const db = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type TwilioCreds = {
  accountSid: string;
  smsCred: string;
  fromPhone: string;
};

async function getTwilioCreds(): Promise<TwilioCreds | null> {
  const { data } = await db
    .from("platform_settings")
    .select("twilio_account_sid, twilio_auth_token, twilio_phone_number")
    .limit(1)
    .maybeSingle();
  if (!data?.twilio_account_sid || !data?.twilio_auth_token || !data?.twilio_phone_number) {
    return null;
  }
  return {
    accountSid: data.twilio_account_sid,
    smsCred: data.twilio_auth_token,
    fromPhone: data.twilio_phone_number,
  };
}

async function sendSms(creds: TwilioCreds, to: string, body: string): Promise<void> {
  const encoded = btoa(`${creds.accountSid}:${creds.smsCred}`);
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${encoded}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: creds.fromPhone, Body: body }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio error: ${text}`);
  }
}

function formatLocalTime(utcIso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
    }).format(new Date(utcIso));
  } catch {
    return utcIso;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const unauthorized = await rejectUnauthorizedInternalRequest(req);
  if (unauthorized) return unauthorized;
  if (!outboundMessagingEnabled()) {
    return new Response(JSON.stringify({ error: "outbound_messaging_disabled" }), { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const targetSalonId: string | undefined = body.salon_id;

  // Window: bookings starting 24–48 hours from now
  const windowStart = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const windowEnd = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  const salonQuery = db
    .from("salons")
    .select("id, name, timezone, subscription_plan, plan_override, feature_flags")
    .is("archived_at", null);

  if (targetSalonId) {
    salonQuery.eq("id", targetSalonId);
  }

  const { data: salons, error: salonsErr } = await salonQuery;
  if (salonsErr) {
    return new Response(JSON.stringify({ error: salonsErr.message }), { status: 500 });
  }

  const twilio = await getTwilioCreds();
  let totalSent = 0;
  const messageLimit = outboundMessageLimit();
  const errors: string[] = [];

  for (const salon of salons ?? []) {
    if (totalSent >= messageLimit) break;
    try {
      // Find confirmed bookings in the 24-48h window with a client phone
      // that haven't received a re-confirm SMS yet
      const { data: upcomingBookings } = await db
        .from("bookings")
        .select(`
          id,
          client_name,
          client_phone,
          start_time_utc,
          services!bookings_service_id_fkey ( name )
        `)
        .eq("salon_id", salon.id)
        .eq("status", "confirmed")
        .gte("start_time_utc", windowStart)
        .lte("start_time_utc", windowEnd)
        .not("client_phone", "is", null)
        .is("reconfirm_sent_at" as never, null);

      if (!upcomingBookings?.length) continue;

      for (const booking of upcomingBookings) {
        if (totalSent >= messageLimit) break;
        try {
          const phone = booking.client_phone as string;
          const serviceName =
            (booking.services as { name?: string } | null)?.name ?? "your appointment";
          const when = formatLocalTime(booking.start_time_utc as string, salon.timezone ?? "America/Vancouver");

          // Check preferred language
          const { data: profile } = await db
            .from("client_profiles")
            .select("id")
            .eq("phone", phone)
            .is("deleted_at", null)
            .maybeSingle();

          let lang = "vi";
          if (profile) {
            const { data: prefs } = await db
              .from("customer_preferences")
              .select("preferred_language")
              .eq("client_profile_id", profile.id)
              .eq("salon_id", salon.id)
              .maybeSingle();
            lang = prefs?.preferred_language ?? "vi";
          }

          const message =
            lang === "en"
              ? `⏰ Reminder: ${serviceName} at ${salon.name} tomorrow · ${when}. Reply STOP to opt out.`
              : `⏰ Nhắc lịch: ${serviceName} tại ${salon.name} · ${when}. Nhắn STOP để huỷ nhận tin.`;

          if (twilio) {
            const consent = await requireSmsConsentClear(db, salon.id, phone);
            if (!consent.allowed) continue;
            await sendSms(twilio, phone, message);
          }

          // Mark as sent
          await db
            .from("bookings")
            .update({ reconfirm_sent_at: new Date().toISOString() } as never)
            .eq("id", booking.id);

          totalSent++;
        } catch (bookingErr) {
          errors.push(
            `booking ${booking.id}: ${bookingErr instanceof Error ? bookingErr.message : String(bookingErr)}`,
          );
        }
      }
    } catch (salonErr) {
      errors.push(
        `salon ${salon.id}: ${salonErr instanceof Error ? salonErr.message : String(salonErr)}`,
      );
    }
  }

  return new Response(JSON.stringify({ ok: true, total_sent: totalSent, errors }), {
    headers: { "content-type": "application/json" },
  });
});
