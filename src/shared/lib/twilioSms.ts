/**
 * Twilio Messages API — outbound SMS for appointment reminders.
 * Server-side only. Separate from twilioVerify (Verify is OTP-only).
 *
 * Credentials priority: platform_settings DB row → env vars.
 * Needs TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN (shared with Verify)
 * plus TWILIO_PHONE_NUMBER (the sender number in E.164, e.g. "+17785550100").
 */

import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";

async function getTwilioSmsCreds(): Promise<{
  accountSid: string;
  authToken: string;
  fromPhone: string;
} | null> {
  try {
    const { createServiceRoleClient } = await import(
      "@/shared/lib/supabase/serviceRole"
    );
    const supabase = createServiceRoleClient();
    const { data } = await supabase
      .from("platform_settings")
      .select("twilio_account_sid, twilio_auth_token, twilio_phone_number")
      .eq("id", "platform")
      .maybeSingle();

    const row = data as {
      twilio_account_sid?: string | null;
      twilio_auth_token?: string | null;
      twilio_phone_number?: string | null;
    } | null;

    const sid   = row?.twilio_account_sid?.trim();
    const token = row?.twilio_auth_token?.trim();
    const from  = row?.twilio_phone_number?.trim();

    if (sid && token && from) {
      return { accountSid: sid, authToken: token, fromPhone: from };
    }
  } catch {
    // Fall through to env vars
  }

  const sid   = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from  = process.env.TWILIO_PHONE_NUMBER?.trim();
  if (sid && token && from) {
    return { accountSid: sid, authToken: token, fromPhone: from };
  }

  return null;
}

/**
 * Normalise any accepted phone form (+country, bare NANP, formatted) to strict
 * E.164 (`+<digits>`) for the Twilio `To` field.  Twilio rejects/mis-routes
 * numbers that lack the leading `+`, and historically callers passed digits-only
 * ("16045551234") or the raw string the voice AI captured — neither is E.164.
 *
 * Reuses the battle-tested libphonenumber parse from `validateGuestPhone`
 * (default region CA) so behaviour matches the booking-storage path exactly.
 * Returns null when the number can't be validated (e.g. bare Vietnamese local
 * "0905123456" with no country code) — the caller treats that as a send failure.
 */
export function normaliseToE164(raw: string): string | null {
  const v = validateGuestPhone(raw);
  return v.ok ? `+${v.digits}` : null;
}

/**
 * Send an outbound SMS reminder.
 * @param toE164 - recipient phone; any accepted form (+country / bare NANP /
 *                 formatted) is normalised to strict E.164 before sending.
 * @param body   - message text (keep under 160 chars to avoid split)
 */
export async function sendSmsReminder(
  toE164: string,
  body: string,
  /** Optional: pass `statusCallbackUrl` so Twilio POSTs delivery receipts. */
  opts?: { statusCallbackUrl?: string },
): Promise<{ ok: boolean; messageSid?: string; error?: string }> {
  const creds = await getTwilioSmsCreds();
  if (!creds) {
    return { ok: false, error: "twilio_not_configured" };
  }

  // Normalise the recipient to E.164 — Twilio needs the leading "+".
  const recipient = normaliseToE164(toE164);
  if (!recipient) {
    // Don't log the full number (PII) — only that normalisation failed.
    console.error("[sendSmsReminder] invalid recipient phone, cannot send (not E.164-normalisable)");
    return { ok: false, error: "invalid_phone" };
  }

  const auth = `Basic ${Buffer.from(
    `${creds.accountSid}:${creds.authToken}`,
  ).toString("base64")}`;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`;

  const params: Record<string, string> = {
    From: creds.fromPhone,
    To:   recipient,
    Body: body,
  };
  if (opts?.statusCallbackUrl) {
    params.StatusCallback = opts.statusCallbackUrl;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("[sendSmsReminder] Twilio error", res.status, text.slice(0, 300));
      return { ok: false, error: `twilio_${res.status}` };
    }

    const json = await res.json() as { sid?: string };
    return { ok: true, messageSid: json.sid };
  } catch (e) {
    console.error("[sendSmsReminder]", e);
    return { ok: false, error: String(e) };
  }
}
