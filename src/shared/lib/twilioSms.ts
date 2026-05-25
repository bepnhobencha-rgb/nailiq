/**
 * Twilio Messages API — outbound SMS for appointment reminders.
 * Server-side only. Separate from twilioVerify (Verify is OTP-only).
 *
 * Credentials priority: platform_settings DB row → env vars.
 * Needs TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN (shared with Verify)
 * plus TWILIO_PHONE_NUMBER (the sender number in E.164, e.g. "+17785550100").
 */

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
 * Send an outbound SMS reminder.
 * @param toE164 - recipient in E.164 format, e.g. "+16045559000"
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

  const auth = `Basic ${Buffer.from(
    `${creds.accountSid}:${creds.authToken}`,
  ).toString("base64")}`;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`;

  const params: Record<string, string> = {
    From: creds.fromPhone,
    To:   toE164,
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
