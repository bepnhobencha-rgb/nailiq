/**
 * Twilio Verify (SMS) — server-side only. Uses REST + fetch (no Twilio SDK).
 *
 * Credentials priority: platform_settings DB row → env vars.
 * This lets SuperAdmin rotate keys without a redeploy.
 *
 * @see https://www.twilio.com/docs/verify/api/verification
 * @see https://www.twilio.com/docs/verify/api/verification-check
 */

import { smsSuppressReason } from "@/shared/lib/twilioSms";

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
 * Sanitize a salon name for Twilio Verify's `CustomFriendlyName` (max 30 chars;
 * keep letters/numbers/spaces only so stray punctuation can't trip the API).
 * Returns "" when nothing usable remains.
 */
function sanitizeFriendlyName(name: string): string {
  return name
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30);
}

/**
 * Start an SMS verification for an E.164 number (must include leading "+").
 *
 * `friendlyName` (e.g. the salon name) is shown in the OTP message
 * ("Your <friendlyName> verification code is: 123456") via Twilio's per-request
 * `CustomFriendlyName`. It is sanitized; if Twilio rejects it (HTTP 400) we
 * retry WITHOUT it so a brand name can never block a customer's OTP. Omit it to
 * fall back to the Verify Service's default friendly name.
 */
export async function sendVerification(
  e164Phone: string,
  friendlyName?: string,
  options?: { deliveryAttemptId?: string },
): Promise<{
  ok: boolean;
  error?: string;
  suppressed?: boolean;
  verificationSid?: string;
  providerAttemptId?: string;
  providerStatus?: string;
}> {
  if (!e164Phone.startsWith("+")) {
    return { ok: false, error: "Invalid phone format." };
  }

  // KILL-SWITCH: never bill real Twilio Verify for disabled-env / non-prod /
  // fictional 555 seed numbers. Same guard as outbound SMS — see smsSuppressReason.
  const suppressReason = smsSuppressReason(e164Phone);
  if (suppressReason) {
    console.warn(`[sendVerification] SUPPRESSED OTP (${suppressReason}) — no real Twilio call`);
    return { ok: true, suppressed: true, providerStatus: "suppressed" };
  }

  const creds = await getTwilioCreds();
  if (!creds) {
    return {
      ok: false,
      error: "twilio_not_configured",
    };
  }

  const auth = `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64")}`;
  const url = `https://verify.twilio.com/v2/Services/${encodeURIComponent(creds.verifyServiceSid)}/Verifications`;
  const fn = friendlyName ? sanitizeFriendlyName(friendlyName) : "";
  const deliveryAttemptId = options?.deliveryAttemptId?.trim() ?? "";
  const taggedAttemptId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    deliveryAttemptId,
  ) ? deliveryAttemptId.toLowerCase() : "";

  const post = (withName: boolean) => {
    const params: Record<string, string> = { To: e164Phone, Channel: "sms" };
    if (withName && fn) params.CustomFriendlyName = fn;
    if (taggedAttemptId) {
      // Twilio includes these non-PII tags in Verify Message Status/Event
      // Streams, allowing a future signed receipt to match this exact claim.
      params.Tags = JSON.stringify({
        nailiq_flow: "booking_otp",
        nailiq_claim: taggedAttemptId,
      });
    }
    return fetch(url, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
    });
  };

  try {
    let res = await post(Boolean(fn));
    // A rejected brand name must NEVER block the customer's code. Verify plans
    // that don't allow custom friendly names return 403 / code 60204 ("Custom
    // friendly name not allowed"); an invalid name returns 400 — in EITHER case
    // retry plain (default friendly name). Before this, only 400 was retried, so
    // 60204 fell through → every booking OTP 500'd platform-wide after the
    // salon-name feature shipped.
    if (!res.ok && (res.status === 400 || res.status === 403) && fn) {
      console.warn(
        "[sendVerification] CustomFriendlyName rejected — retrying without it",
      );
      res = await post(false);
    }

    const text = await res.text();
    if (!res.ok) {
      console.error("[sendVerification] Twilio API error", {
        status: res.status,
        body: text.slice(0, 300),
      });
      return { ok: false, error: `twilio_${res.status}` };
    }
    const body = parseTwilioJson(text);
    const verificationSid = typeof body.sid === "string" ? body.sid : "";
    const providerStatus = typeof body.status === "string"
      ? body.status.toLowerCase()
      : "";
    const attempts = Array.isArray(body.send_code_attempts)
      ? body.send_code_attempts
      : [];
    const latest = attempts.at(-1);
    const providerAttemptId = latest && typeof latest === "object" &&
      typeof (latest as { attempt_sid?: unknown }).attempt_sid === "string"
      ? String((latest as { attempt_sid: string }).attempt_sid)
      : "";
    if (!/^VE[0-9a-f]{32}$/i.test(verificationSid) || providerStatus !== "pending") {
      return {
        ok: false,
        error: "provider_response_unverified",
        verificationSid: /^VE[0-9a-f]{32}$/i.test(verificationSid)
          ? verificationSid
          : undefined,
        providerAttemptId: /^VL[0-9a-f]{32}$/i.test(providerAttemptId)
          ? providerAttemptId
          : undefined,
        providerStatus: providerStatus || undefined,
      };
    }

    return {
      ok: true,
      verificationSid,
      providerAttemptId: /^VL[0-9a-f]{32}$/i.test(providerAttemptId)
        ? providerAttemptId
        : undefined,
      providerStatus,
    };
  } catch (e) {
    console.error("[sendVerification]", e);
    return { ok: false, error: "provider_response_unknown" };
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
