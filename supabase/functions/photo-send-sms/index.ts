// Supabase Edge Function — photo-send-sms
// Called after AI processing completes.
// PIPEDA-compliant: only sends if consent_receive_sms = true AND revoked_at IS NULL.
// Signs a JWT with 30-day expiry and sends via Twilio.

import { createClient } from "npm:@supabase/supabase-js@2";
import * as jose from "npm:jose@5";
import {
  outboundMessagingEnabled,
  rejectUnauthorizedInternalRequest,
} from "../_shared/internalAuth.ts";
import { supabaseSecretKey } from "../_shared/supabaseApiKeys.ts";
import { requireSmsConsentClear } from "../_shared/smsConsentSuppression.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = supabaseSecretKey();
const JWT_SECRET = Deno.env.get("JWT_SECRET")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sendTwilioSms(opts: {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  toNumber: string;
  body: string;
}): Promise<void> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${opts.accountSid}/Messages.json`;
  const creds = btoa(`${opts.accountSid}:${opts.authToken}`);

  const formBody = new URLSearchParams({
    From: opts.fromNumber,
    To: opts.toNumber,
    Body: opts.body,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formBody.toString(),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Twilio error ${response.status}: ${errText}`);
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
  if (!outboundMessagingEnabled()) return jsonError("outbound_messaging_disabled", 503);

  let body: { photo_id?: string };
  try {
    body = await req.json() as { photo_id?: string };
  } catch {
    return jsonError("Invalid JSON body");
  }

  const photoId = body.photo_id?.trim();
  if (!photoId) return jsonError("Missing photo_id");

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Fetch booking_photos row with booking info
  const { data: photoRow, error: photoErr } = await db
    .from("booking_photos")
    .select(`
      id,
      salon_id,
      booking_id,
      sms_sent_at,
      bookings (
        client_phone,
        client_name
      )
    `)
    .eq("id", photoId)
    .is("deleted_at", null)
    .maybeSingle();

  if (photoErr || !photoRow) {
    return jsonError("Photo not found", 404);
  }

  // Don't re-send
  if (photoRow.sms_sent_at) {
    return new Response(
      JSON.stringify({ skipped: true, reason: "already_sent" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  type BookingRef = { client_phone: string | null; client_name: string } | null;
  const booking = photoRow.bookings as BookingRef;
  const clientPhone = booking?.client_phone?.trim() ?? null;

  if (!clientPhone) {
    return jsonError("Booking has no client phone number", 422);
  }

  // PIPEDA: check consent — must have active consent for this salon
  const { data: consent } = await db
    .from("customer_photo_consents")
    .select("id, consent_receive_sms, revoked_at")
    .eq("salon_id", photoRow.salon_id)
    .eq("client_phone", clientPhone)
    .is("revoked_at", null)
    .order("granted_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!consent || !consent.consent_receive_sms) {
    return new Response(
      JSON.stringify({ skipped: true, reason: "no_sms_consent" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const suppression = await requireSmsConsentClear(db, photoRow.salon_id, clientPhone);
  if (!suppression.allowed) {
    return suppression.reason === "consent_unavailable"
      ? jsonError("SMS consent state unavailable", 503)
      : new Response(
        JSON.stringify({ skipped: true, reason: suppression.reason }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
  }

  // Get Twilio credentials from platform_settings
  const { data: platformSettings } = await db
    .from("platform_settings")
    .select("twilio_account_sid, twilio_auth_token, twilio_phone_number")
    .limit(1)
    .maybeSingle();

  if (
    !platformSettings?.twilio_account_sid ||
    !platformSettings?.twilio_auth_token ||
    !platformSettings?.twilio_phone_number
  ) {
    console.error("[photo-send-sms] Twilio credentials not configured");
    return jsonError("SMS service not configured", 503);
  }

  // Bind the public bearer to the exact photo, salon, and normalized booking
  // phone. App routes also require the issuer/audience so this token cannot be
  // confused with another NailIQ JWT purpose.
  const secretBytes = new TextEncoder().encode(JWT_SECRET);
  const signedToken = await new jose.SignJWT({
    photo_id: photoId,
    salon_id: photoRow.salon_id,
    client_phone: clientPhone.replace(/\D/g, ""),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("nailiq-photo-send-sms")
    .setAudience("nailiq-photo-customer")
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secretBytes);

  const viewUrl = `https://nailiq.ca/v/${signedToken}`;
  const clientName = booking?.client_name ?? "there";

  // Send SMS via Twilio
  try {
    await sendTwilioSms({
      accountSid: platformSettings.twilio_account_sid,
      authToken: platformSettings.twilio_auth_token,
      fromNumber: platformSettings.twilio_phone_number,
      toNumber: clientPhone,
      body: `Hi ${clientName}! Your nails look amazing! View + save your photos: ${viewUrl}`,
    });
  } catch (err) {
    console.error("[photo-send-sms] Twilio send error:", err);
    return jsonError("Failed to send SMS", 500);
  }

  // Update sms_sent_at
  await db
    .from("booking_photos")
    .update({ sms_sent_at: new Date().toISOString() })
    .eq("id", photoId);

  return new Response(
    JSON.stringify({ ok: true, sent_to: clientPhone }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
