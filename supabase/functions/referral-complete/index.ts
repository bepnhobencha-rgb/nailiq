// Supabase Edge Function — referral-complete
// Called when a referee booking flips to status='completed'.
// POST { booking_id }
// Issues vouchers for both referrer and referee, sends SMS notifications.

import { createClient } from "npm:@supabase/supabase-js@2";
import { rejectUnauthorizedInternalRequest } from "../_shared/internalAuth.ts";
import { supabaseSecretKey } from "../_shared/supabaseApiKeys.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = supabaseSecretKey();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Generates a random uppercase voucher code like "REW3X9K" */
function generateVoucherCode(prefix = "REW"): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = prefix;
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function sendTwilioSms(
  twilioAccountSid: string,
  twilioAuthToken: string,
  fromPhone: string,
  toPhone: string,
  body: string,
): Promise<void> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`;
  const encoded = btoa(`${twilioAccountSid}:${twilioAuthToken}`);
  const params = new URLSearchParams({
    To: toPhone,
    From: fromPhone,
    Body: body,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${encoded}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio SMS failed: ${res.status} ${text}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonError("Method not allowed", 405);
  }

  const unauthorized = await rejectUnauthorizedInternalRequest(req, corsHeaders);
  if (unauthorized) return unauthorized;

  let body: { booking_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON");
  }

  const { booking_id } = body;
  if (!booking_id) {
    return jsonError("Missing booking_id");
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Find a referral where referee_booking_id = booking_id AND status = 'used'
  const { data: referral, error: refError } = await supabase
    .from("referrals")
    .select(
      "id, salon_id, referrer_phone, referee_phone, referrer_reward_percent_off, referee_reward_percent_off, status",
    )
    .eq("referee_booking_id", booking_id)
    .eq("status", "used")
    .maybeSingle();

  if (refError) {
    console.error("[referral-complete] lookup error:", refError);
    return jsonError("Database error", 500);
  }

  if (!referral) {
    // No referral to process — not an error, just a no-op
    return jsonOk({ ok: true, skipped: true });
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const referrerPercent = referral.referrer_reward_percent_off ?? 10;
  const refereePercent = referral.referee_reward_percent_off ?? 10;

  // Issue voucher for referrer
  const referrerCode = generateVoucherCode("REF");
  const { data: referrerVoucher, error: referrerVoucherError } = await supabase
    .from("vouchers")
    .insert({
      salon_id: referral.salon_id,
      code: referrerCode,
      kind: "referral_reward",
      percent_off: referrerPercent,
      max_uses: 1,
      valid_from: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      client_phone: referral.referrer_phone,
    })
    .select("id")
    .single();

  if (referrerVoucherError) {
    console.error("[referral-complete] referrer voucher insert error:", referrerVoucherError);
    return jsonError("Failed to issue referrer voucher", 500);
  }

  // Issue voucher for referee
  const refereeCode = generateVoucherCode("REF");
  const { data: refereeVoucher, error: refereeVoucherError } = await supabase
    .from("vouchers")
    .insert({
      salon_id: referral.salon_id,
      code: refereeCode,
      kind: "referral_reward",
      percent_off: refereePercent,
      max_uses: 1,
      valid_from: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      client_phone: referral.referee_phone ?? undefined,
    })
    .select("id")
    .single();

  if (refereeVoucherError) {
    console.error("[referral-complete] referee voucher insert error:", refereeVoucherError);
    return jsonError("Failed to issue referee voucher", 500);
  }

  // Update referrals row
  const { error: updateError } = await supabase
    .from("referrals")
    .update({
      referrer_voucher_id: referrerVoucher.id,
      referee_voucher_id: refereeVoucher.id,
      status: "completed",
      completed_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("id", referral.id);

  if (updateError) {
    console.error("[referral-complete] referral update error:", updateError);
    return jsonError("Failed to update referral record", 500);
  }

  // Fetch Twilio credentials from platform_settings
  const { data: platformSettings } = await supabase
    .from("platform_settings")
    .select("twilio_account_sid, twilio_auth_token, twilio_phone_number")
    .limit(1)
    .maybeSingle();

  if (
    platformSettings?.twilio_account_sid &&
    platformSettings?.twilio_auth_token &&
    platformSettings?.twilio_phone_number
  ) {
    const { twilio_account_sid, twilio_auth_token, twilio_phone_number } = platformSettings;

    const referrerMsg =
      `Your friend visited! Your ${referrerPercent}% off voucher code: ${referrerCode} (valid 30 days)`;
    const refereeMsg =
      `Thanks for visiting! Your ${refereePercent}% off voucher: ${refereeCode} (valid 30 days)`;

    // Fire-and-forget — don't fail the whole request if SMS fails
    try {
      await sendTwilioSms(
        twilio_account_sid,
        twilio_auth_token,
        twilio_phone_number,
        referral.referrer_phone,
        referrerMsg,
      );
    } catch (err) {
      console.error("[referral-complete] referrer SMS failed:", err);
    }

    if (referral.referee_phone) {
      try {
        await sendTwilioSms(
          twilio_account_sid,
          twilio_auth_token,
          twilio_phone_number,
          referral.referee_phone,
          refereeMsg,
        );
      } catch (err) {
        console.error("[referral-complete] referee SMS failed:", err);
      }
    }
  }

  return jsonOk({
    ok: true,
    referral_id: referral.id,
    referrer_voucher_id: referrerVoucher.id,
    referee_voucher_id: refereeVoucher.id,
    referrer_code: referrerCode,
    referee_code: refereeCode,
  });
});
