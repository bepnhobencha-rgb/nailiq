// Supabase Edge Function — cron-birthday-voucher
// Runs daily at 09:00 per salon timezone via Supabase cron.
// POST { salon_id?: string }  — if omitted, processes all Studio+ salons.
//
// For each Studio+ salon, finds clients whose birthday month == current month,
// who haven't received a voucher this year. Issues a 10% off voucher valid
// for the current calendar month and sends a bilingual SMS.
// Twilio credentials are fetched from platform_settings (not env vars) so
// the salon admin controls them via the dashboard.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  outboundMessageLimit,
  outboundMessagingEnabled,
  rejectUnauthorizedInternalRequest,
} from "../_shared/internalAuth.ts";
import { supabaseSecretKey } from "../_shared/supabaseApiKeys.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = supabaseSecretKey();

const db = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type TwilioCreds = {
  accountSid: string;
  authToken: string;
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
    authToken: data.twilio_auth_token,
    fromPhone: data.twilio_phone_number,
  };
}

async function sendSms(creds: TwilioCreds, to: string, body: string): Promise<void> {
  const encoded = btoa(`${creds.accountSid}:${creds.authToken}`);
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

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const unauthorized = await rejectUnauthorizedInternalRequest(req);
  if (unauthorized) return unauthorized;
  if (!outboundMessagingEnabled()) {
    return new Response(JSON.stringify({ error: "outbound_messaging_disabled" }), { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const targetSalonId: string | undefined = body.salon_id;

  // Only Studio+ salons (premium/enterprise), with optional single-salon override
  const salonQuery = db
    .from("salons")
    .select("id, name, subscription_plan, plan_override, feature_flags, timezone")
    .is("archived_at", null);

  if (targetSalonId) {
    salonQuery.eq("id", targetSalonId);
  } else {
    salonQuery.in("subscription_plan", ["premium", "enterprise"]);
  }

  const { data: salons, error: salonsErr } = await salonQuery;
  if (salonsErr) {
    return new Response(JSON.stringify({ error: salonsErr.message }), { status: 500 });
  }

  // Filter plan_override as well (plan_override beats subscription_plan)
  const studioPlanSalons = (salons ?? []).filter((s) => {
    const flags = s.feature_flags as Record<string, boolean> | null;
    if (flags?.["birthday_voucher"] === false) return false;
    const plan = (s.plan_override ?? s.subscription_plan) as string;
    return ["premium", "enterprise"].includes(plan);
  });

  const twilio = await getTwilioCreds();
  let totalSent = 0;
  const messageLimit = outboundMessageLimit();
  const errors: string[] = [];

  const now = new Date();
  const currentMonth = now.getMonth() + 1; // 1-12
  const currentYear = now.getFullYear();
  const monthStart = new Date(currentYear, currentMonth - 1, 1).toISOString();
  const monthEnd = new Date(currentYear, currentMonth, 0, 23, 59, 59).toISOString();
  const twoYearsAgo = new Date(now.getTime() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
  const mmPadded = String(currentMonth).padStart(2, "0");

  for (const salon of studioPlanSalons) {
    if (totalSent >= messageLimit) break;
    try {
      // Find phones with a completed booking at this salon in the last 2 years
      const { data: activeBookings } = await db
        .from("bookings")
        .select("client_phone")
        .eq("salon_id", salon.id)
        .eq("status", "completed")
        .gte("start_time_utc", twoYearsAgo)
        .not("client_phone", "is", null);

      if (!activeBookings?.length) continue;

      const activePhones = [...new Set(
        activeBookings.map((b: { client_phone: string | null }) => b.client_phone).filter(Boolean) as string[],
      )];

      // Fetch client_profiles with birthday this month who haven't got voucher this year
      // We filter by month client-side because birthday month extraction via PostgREST
      // requires a computed column; string matching on MM portion is reliable for YYYY-MM-DD.
      const { data: clients } = await db
        .from("client_profiles")
        .select("id, phone, name, birthday, birthday_voucher_sent_year")
        .in("phone", activePhones)
        .is("deleted_at", null)
        .not("birthday", "is", null)
        .or(`birthday_voucher_sent_year.is.null,birthday_voucher_sent_year.lt.${currentYear}`);

      // Client-side month check: birthday is stored as YYYY-MM-DD
      const birthdayClients = (clients ?? []).filter((c) => {
        if (!c.birthday) return false;
        // Extract MM from YYYY-MM-DD
        const mm = (c.birthday as string).slice(5, 7);
        return mm === mmPadded;
      });

      for (const client of birthdayClients) {
        if (totalSent >= messageLimit) break;
        try {
          // Unique code: BDAY{phone_last4}{year} — deterministic so duplicate inserts fail gracefully
          const code = `BDAY${(client.phone as string).slice(-4)}${currentYear}`;

          const { data: voucher, error: voucherErr } = await db
            .from("vouchers")
            .insert({
              salon_id: salon.id,
              code,
              kind: "birthday",
              percent_off: 10,
              max_uses: 1,
              valid_from: monthStart,
              expires_at: monthEnd,
              client_phone: client.phone,
              client_profile_id: client.id,
            })
            .select("id, code")
            .single();

          if (voucherErr || !voucher) {
            // Likely duplicate — already sent
            continue;
          }

          // Preferred language for bilingual SMS
          const { data: prefs } = await db
            .from("customer_preferences")
            .select("preferred_language")
            .eq("client_profile_id", client.id)
            .eq("salon_id", salon.id)
            .maybeSingle();

          const lang = prefs?.preferred_language ?? "vi";
          const name = (client.name as string | null) ?? "bạn";

          const message =
            lang === "en"
              ? `🎂 Happy Birthday, ${name}! A gift from ${salon.name}: 10% off your next visit this month. Code: ${voucher.code}`
              : `🎂 Chúc mừng sinh nhật, ${name}! ${salon.name} tặng bạn voucher 10% off tháng này. Mã: ${voucher.code}`;

          if (twilio) {
            await sendSms(twilio, client.phone as string, message);
          }

          // Mark sent this year
          await db
            .from("client_profiles")
            .update({ birthday_voucher_sent_year: currentYear })
            .eq("id", client.id);

          totalSent++;
        } catch (clientErr) {
          errors.push(
            `${client.phone}: ${clientErr instanceof Error ? clientErr.message : String(clientErr)}`,
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
