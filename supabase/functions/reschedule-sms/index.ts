// Supabase Edge Function — reschedule-sms
// Sends a transactional SMS telling a customer their appointment was moved,
// IN THE LANGUAGE THEY WERE BROWSING when they booked.
//
// Language strategy (scales to 10+ languages with NO code change):
//   * Locale source order: explicit `lang` override → bookings.client_locale →
//     customer_preferences.preferred_language → 'vi' (primary-market default).
//   * Message body is data: looked up from `notification_templates`
//     (template_key='booking_reschedule', channel='sms') with graceful fallback
//     resolved-locale → base language → 'en' → 'vi' → hardcoded safety net.
//   * Date/time is formatted by Intl in the resolved locale — Intl already
//     knows every BCP-47 locale, so new languages need zero formatting code.
// Adding a new language = INSERT one row into notification_templates.
//
// Body: { booking_id: string, lang?: string }
//   - lang is an optional BCP-47 override; omit it to auto-resolve.
//
// This is a *transactional* service message about the customer's own booking,
// so it does not gate on marketing consent. verify_jwt is disabled to match the
// sibling internal SMS function; booking_id is an unguessable UUID.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  outboundMessagingEnabled,
  rejectUnauthorizedInternalRequest,
} from "../_shared/internalAuth.ts";
import { supabaseSecretKey } from "../_shared/supabaseApiKeys.ts";
import { requireSmsConsentClear } from "../_shared/smsConsentSuppression.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = supabaseSecretKey();

const TEMPLATE_KEY = "booking_reschedule";
const CHANNEL = "sms";
const DEFAULT_LOCALE = "vi"; // matches resolveBookingLanguage() server-side default

// Last-resort body if the templates table is empty/unreachable. Real copy lives
// in notification_templates — this only guarantees we never fail to notify.
const SAFETY_NET: Record<string, string> = {
  en: "Hi {name}, this is {salon}. Your {service} appointment has been rescheduled to {when}. See you then!",
  vi: "Chào {name}, {salon} xin báo: lịch hẹn {service} của bạn đã được dời sang {when}. Hẹn gặp bạn!",
};

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

function jsonOk(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Normalize a stored phone (e.g. "14044443800" or "+1 404-444-3800") to E.164.
function toE164(raw: string): string {
  const digits = raw.trim().replace(/[^\d]/g, "");
  return digits ? "+" + digits : "";
}

// Base language of a BCP-47 tag: "en-US" -> "en", "zh-Hant" -> "zh".
function baseLang(locale: string): string {
  return locale.toLowerCase().split(/[-_]/)[0];
}

function formatWhen(startUtc: string, tz: string, locale: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: baseLang(locale) === "en",
    timeZone: tz,
  };
  try {
    return new Intl.DateTimeFormat(locale, opts).format(new Date(startUtc));
  } catch {
    // Invalid/unknown locale tag — fall back to a safe formatter.
    return new Intl.DateTimeFormat("en-US", opts).format(new Date(startUtc));
  }
}

// Interpolate {placeholders} and tidy whitespace/punctuation left by empty slots
// (e.g. a missing {service} must not leave a double space or " .").
function render(body: string, vars: Record<string, string>): string {
  return body
    .replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

async function sendTwilioSms(opts: {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  toNumber: string;
  body: string;
}): Promise<string> {
  const url =
    `https://api.twilio.com/2010-04-01/Accounts/${opts.accountSid}/Messages.json`;
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
    throw new Error(`Twilio error ${response.status}: ${await response.text()}`);
  }
  const data = await response.json() as { sid?: string };
  return data.sid ?? "";
}

type DB = ReturnType<typeof createClient>;

// Resolve the customer's locale from the most specific signal available.
async function resolveLocale(
  db: DB,
  bk: { client_locale: string | null; client_phone: string | null; salon_id: string },
  override: string | null,
): Promise<string> {
  if (override && override.trim()) return override.trim().toLowerCase();
  if (bk.client_locale && bk.client_locale.trim()) {
    return bk.client_locale.trim().toLowerCase();
  }
  // Fall back to the stored preference captured at booking-confirm time.
  const phone = bk.client_phone?.trim();
  if (phone) {
    const { data: profile } = await db
      .from("client_profiles")
      .select("id")
      .eq("phone", phone)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (profile?.id) {
      const { data: pref } = await db
        .from("customer_preferences")
        .select("preferred_language")
        .eq("client_profile_id", profile.id)
        .eq("salon_id", bk.salon_id)
        .maybeSingle();
      if (pref?.preferred_language) return pref.preferred_language.toLowerCase();
    }
  }
  return DEFAULT_LOCALE;
}

// Pick the best template body for a locale, walking the fallback chain.
async function resolveBody(db: DB, locale: string): Promise<string> {
  const chain = Array.from(
    new Set([locale, baseLang(locale), "en", DEFAULT_LOCALE]),
  );
  const { data: rows } = await db
    .from("notification_templates")
    .select("locale, body")
    .eq("template_key", TEMPLATE_KEY)
    .eq("channel", CHANNEL)
    .in("locale", chain);

  for (const pref of chain) {
    const hit = (rows ?? []).find((r: { locale: string }) => r.locale === pref);
    if (hit) return hit.body as string;
  }
  // Templates table miss — use the embedded safety net.
  return SAFETY_NET[baseLang(locale)] ?? SAFETY_NET.en;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") return jsonError("Method not allowed", 405);

  const unauthorized = await rejectUnauthorizedInternalRequest(req, corsHeaders);
  if (unauthorized) return unauthorized;
  if (!outboundMessagingEnabled()) return jsonError("outbound_messaging_disabled", 503);

  let body: { booking_id?: string; lang?: string };
  try {
    body = await req.json() as { booking_id?: string; lang?: string };
  } catch {
    return jsonError("Invalid JSON body");
  }

  const bookingId = body.booking_id?.trim();
  if (!bookingId) return jsonError("Missing booking_id");

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Explicit FK hints avoid ambiguity (bookings has service_id + addon_service_id).
  const { data: bk, error: bkErr } = await db
    .from("bookings")
    .select(`
      id,
      salon_id,
      status,
      deleted_at,
      client_phone,
      client_name,
      client_locale,
      start_time_utc,
      salon:salon_id ( name, timezone ),
      service:service_id ( name )
    `)
    .eq("id", bookingId)
    .maybeSingle();

  if (bkErr) return jsonError(bkErr.message, 500);
  if (!bk) return jsonError("Booking not found", 404);
  if (bk.deleted_at) return jsonError("Booking is deleted", 422);
  if (bk.status === "cancelled" || bk.status === "no_show") {
    return jsonOk({ skipped: true, reason: `status_${bk.status}` });
  }
  if (!bk.start_time_utc) return jsonError("Booking has no start time", 422);

  const rawPhone = bk.client_phone?.trim();
  if (!rawPhone) return jsonError("Booking has no client phone number", 422);
  const toNumber = toE164(rawPhone);
  if (!toNumber) return jsonError("Booking phone is not a valid number", 422);

  type SalonRef = { name: string | null; timezone: string | null } | null;
  type ServiceRef = { name: string | null } | null;
  const salon = bk.salon as SalonRef;
  const service = bk.service as ServiceRef;

  const locale = await resolveLocale(db, {
    client_locale: bk.client_locale,
    client_phone: rawPhone,
    salon_id: bk.salon_id,
  }, body.lang ?? null);

  const tz = salon?.timezone ?? "America/Los_Angeles";
  const templateBody = await resolveBody(db, locale);

  const smsBody = render(templateBody, {
    name: bk.client_name?.trim() || "",
    salon: salon?.name?.trim() || "",
    when: formatWhen(bk.start_time_utc, tz, locale),
    service: service?.name?.trim() || "",
  });

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
    console.error("[reschedule-sms] Twilio credentials not configured");
    return jsonError("SMS service not configured", 503);
  }

  const consent = await requireSmsConsentClear(db, bk.salon_id, toNumber);
  if (!consent.allowed) {
    return consent.reason === "consent_unavailable"
      ? jsonError("SMS consent state unavailable", 503)
      : jsonOk({ ok: true, skipped: true, reason: consent.reason });
  }

  let sid: string;
  try {
    sid = await sendTwilioSms({
      accountSid: platformSettings.twilio_account_sid,
      authToken: platformSettings.twilio_auth_token,
      fromNumber: platformSettings.twilio_phone_number,
      toNumber,
      body: smsBody,
    });
  } catch (err) {
    console.error("[reschedule-sms] Twilio send error:", err);
    return jsonError("Failed to send SMS", 500);
  }

  return jsonOk({ ok: true, sid, sent_to: toNumber, locale });
});
