/**
 * Twilio Verify (SMS) — server-side only. Uses REST + fetch (no Twilio SDK).
 *
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID
 *
 * @see https://www.twilio.com/docs/verify/api/verification
 * @see https://www.twilio.com/docs/verify/api/verification-check
 */

function twilioBasicAuthHeader(): string | null {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!sid || !token) return null;
  return `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
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
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID?.trim();
  const auth = twilioBasicAuthHeader();
  if (!serviceSid || !auth) {
    return {
      ok: false,
      error: "SMS is not configured (Twilio environment variables).",
    };
  }
  if (!e164Phone.startsWith("+")) {
    return { ok: false, error: "Invalid phone format." };
  }

  const url = `https://verify.twilio.com/v2/Services/${encodeURIComponent(serviceSid)}/Verifications`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: e164Phone,
        Channel: "sms",
      }).toString(),
    });

    const text = await res.text();
    if (!res.ok) {
      console.error("[sendVerification] Twilio API error", {
        status: res.status,
        statusText: res.statusText,
        body: text,
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
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID?.trim();
  const auth = twilioBasicAuthHeader();
  if (!serviceSid || !auth) {
    return {
      ok: false,
      error: "server_misconfigured",
    };
  }
  if (!e164Phone.startsWith("+")) {
    return { ok: false, error: "invalid_phone" };
  }

  const url = `https://verify.twilio.com/v2/Services/${encodeURIComponent(serviceSid)}/VerificationCheck`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: e164Phone,
        Code: code,
      }).toString(),
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

    /* Wrong code often returns 200 + pending / canceled */
    return { ok: false, error: "invalid_code" };
  } catch (e) {
    console.error("[checkVerification]", e);
    return { ok: false, error: "invalid_code" };
  }
}
