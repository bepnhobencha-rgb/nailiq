/**
 * Twilio Verify (SMS) — server-side only. Uses REST + fetch (no Twilio SDK).
 *
 * Credentials priority: platform_settings DB row → env vars.
 * This lets SuperAdmin rotate keys without a redeploy.
 *
 * @see https://www.twilio.com/docs/verify/api/verification
 * @see https://www.twilio.com/docs/verify/api/verification-check
 */

type TwilioCreds = {
  accountSid: string;
  authToken: string;
  verifyServiceSid: string;
};

async function getTwilioCreds(): Promise<TwilioCreds | null> {
  // Try platform_settings first (set via SuperAdmin UI).
  try {
    const { createServiceRoleClient } = await import(
      "@/shared/lib/supabase/serviceRole"
    );
    const supabase = createServiceRoleClient();
    const { data } = await supabase
      .from("platform_settings")
      .select("twilio_account_sid, twilio_auth_token, twilio_verify_service_sid")
      .eq("id", "platform")
      .maybeSingle();

    const row = data as {
      twilio_account_sid?: string | null;
      twilio_auth_token?: string | null;
      twilio_verify_service_sid?: string | null;
    } | null;

    const sid = row?.twilio_account_sid?.trim();
    const token = row?.twilio_auth_token?.trim();
    const vsid = row?.twilio_verify_service_sid?.trim();

    if (sid && token && vsid) {
      return { accountSid: sid, authToken: token, verifyServiceSid: vsid };
    }
  } catch {
    // Fall through to env vars
  }

  // Env var fallback.
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const vsid = process.env.TWILIO_VERIFY_SERVICE_SID?.trim();
  if (sid && token && vsid) {
    return { accountSid: sid, authToken: token, verifyServiceSid: vsid };
  }

  return null;
}

function parseTwilioJson(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Start an SMS verification for an E.164 number (must include leading "+").
 */
export async function sendVerification(
  e164Phone: string,
): Promise<{ ok: boolean; error?: string }> {
  const creds = await getTwilioCreds();
  if (!creds) {
    return {
      ok: false,
      error: "SMS is not configured (Twilio credentials missing).",
    };
  }
  if (!e164Phone.startsWith("+")) {
    return { ok: false, error: "Invalid phone format." };
  }

  const auth = `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64")}`;
  const url = `https://verify.twilio.com/v2/Services/${encodeURIComponent(creds.verifyServiceSid)}/Verifications`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: e164Phone, Channel: "sms" }).toString(),
    });

    const text = await res.text();
    if (!res.ok) {
      console.error("[sendVerification] Twilio API error", {
        status: res.status,
        body: text.slice(0, 300),
      });
      return { ok: false, error: "Could not send SMS. Try again." };
    }

    return { ok: true };
  } catch (e) {
    console.error("[sendVerification]", e);
    return { ok: false, error: "Could not send SMS. Try again." };
  }
}

/**
 * Validate a verification code for an E.164 number (must include leading "+").
 */
export async function checkVerification(
  e164Phone: string,
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  const creds = await getTwilioCreds();
  if (!creds) {
    return { ok: false, error: "server_misconfigured" };
  }
  if (!e164Phone.startsWith("+")) {
    return { ok: false, error: "invalid_phone" };
  }

  const auth = `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64")}`;
  const url = `https://verify.twilio.com/v2/Services/${encodeURIComponent(creds.verifyServiceSid)}/VerificationCheck`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: e164Phone, Code: code }).toString(),
    });

    const text = await res.text();
    const body = parseTwilioJson(text);
    const status =
      typeof body.status === "string" ? body.status.toLowerCase() : "";

    if (res.status === 404) {
      return { ok: false, error: "expired_or_max_attempts" };
    }

    if (!res.ok) {
      console.error("[checkVerification] Twilio", res.status, text.slice(0, 300));
      return { ok: false, error: "invalid_code" };
    }

    if (status === "approved") {
      return { ok: true };
    }

    return { ok: false, error: "invalid_code" };
  } catch (e) {
    console.error("[checkVerification]", e);
    return { ok: false, error: "invalid_code" };
  }
}
