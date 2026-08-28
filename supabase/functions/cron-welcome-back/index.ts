// Supabase Edge Function — cron-welcome-back
// Runs weekly on Monday at 10:00 via Supabase cron.
// POST { salon_id?: string }  — if omitted, processes all Studio+ salons.
//
// Finds clients who haven't visited in 60+ days and haven't received a
// welcome_back voucher in the last 90 days. Issues 15% off for 30 days
// and sends a bilingual SMS.
// Twilio credentials come from platform_settings, not env vars.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  legacyDirectSmsDispatchEnabled,
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

// Module-level twilio ref populated once per cold start
let _twilio: TwilioCreds | null | undefined = undefined;

async function doSendSms(creds: TwilioCreds, to: string, body: string): Promise<void> {
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
  if (!legacyDirectSmsDispatchEnabled()) {
    return new Response(JSON.stringify({ error: "durable_sms_dispatch_required" }), { status: 503 });
  }
  if (!outboundMessagingEnabled()) {
    return new Response(JSON.stringify({ error: "outbound_messaging_disabled" }), { status: 503 });
  }

  // Lazy-load Twilio creds once per cold start
  if (_twilio === undefined) {
    _twilio = await getTwilioCreds();
  }

  const body = await req.json().catch(() => ({}));
  const targetSalonId: string | undefined = body.salon_id;

  const salonQuery = db
    .from("salons")
    .select("id, name, subscription_plan, plan_override, feature_flags")
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

  // Honour plan_override + feature flag gate
  const studioPlanSalons = (salons ?? []).filter((s) => {
    const flags = s.feature_flags as Record<string, boolean> | null;
    if (flags?.["welcome_back_voucher"] === false) return false;
    const plan = (s.plan_override ?? s.subscription_plan) as string;
    return ["premium", "enterprise"].includes(plan);
  });

  let totalSent = 0;
  const messageLimit = outboundMessageLimit();
  const errors: string[] = [];

  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  for (const salon of studioPlanSalons) {
    if (totalSent >= messageLimit) break;
    try {
      // Find clients with last_service_date < 60 days ago (lapsed) linked to this salon
      const { data: lapsedProfiles } = await db
        .from("client_profiles")
        .select("id, phone, name, last_service_date")
        .is("deleted_at", null)
        .not("last_service_date", "is", null)
        .lt("last_service_date", sixtyDaysAgo);

      if (!lapsedProfiles?.length) continue;

      const lapsedPhones = lapsedProfiles.map((c: { phone: string }) => c.phone);

      // Narrow to phones that have at least one completed booking at this salon
      const { data: salonVisitors } = await db
        .from("bookings")
        .select("client_phone")
        .eq("salon_id", salon.id)
        .eq("status", "completed")
        .in("client_phone", lapsedPhones)
        .not("client_phone", "is", null);

      if (!salonVisitors?.length) continue;

      const visitorPhoneSet = new Set(
        salonVisitors.map((b: { client_phone: string | null }) => b.client_phone).filter(Boolean),
      );

      const eligibleClients = lapsedProfiles.filter((c: { phone: string }) =>
        visitorPhoneSet.has(c.phone),
      );

      for (const client of eligibleClients) {
        if (totalSent >= messageLimit) break;
        try {
          // Check no welcome_back voucher issued in last 90 days for this client+salon
          const { count: recentVouchers } = await db
            .from("vouchers")
            .select("*", { count: "exact", head: true })
            .eq("salon_id", salon.id)
            .eq("client_phone", client.phone)
            .eq("kind", "welcome_back")
            .gte("created_at", ninetyDaysAgo);

          if (recentVouchers && recentVouchers > 0) continue;

          // Unique code: BACK{phone_last4}{random_base36}
          const code = `BACK${(client.phone as string).slice(-4)}${Date.now().toString(36).toUpperCase().slice(-3)}`;

          const { data: voucher, error: voucherErr } = await db
            .from("vouchers")
            .insert({
              salon_id: salon.id,
              code,
              kind: "welcome_back",
              percent_off: 15,
              max_uses: 1,
              valid_from: new Date().toISOString(),
              expires_at: thirtyDaysFromNow,
              client_phone: client.phone,
              client_profile_id: client.id,
            })
            .select("id, code")
            .single();

          if (voucherErr || !voucher) continue;

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
              ? `We miss you, ${name}! Come back to ${salon.name} and save 15% off your next visit. Valid 30 days. Code: ${voucher.code}`
              : `Lâu lắm rồi không gặp, ${name}! ${salon.name} nhớ bạn. Giảm 15% lần ghé tới, hiệu lực 30 ngày. Mã: ${voucher.code}`;

          if (_twilio) {
            const consent = await requireSmsConsentClear(db, salon.id, client.phone as string);
            if (!consent.allowed) continue;
            await doSendSms(_twilio, client.phone as string, message);
          }

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
