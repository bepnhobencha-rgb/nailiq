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

const TWILIO_MESSAGE_SID_RE = /^(SM|MM)[0-9a-f]{32}$/i;
const TWILIO_MESSAGE_STATUSES = new Set([
  "accepted",
  "scheduled",
  "queued",
  "sending",
  "sent",
  "delivered",
  "undelivered",
  "failed",
  "receiving",
  "received",
  "read",
  "canceled",
]);

/**
 * Read a Twilio message's current provider status through the same credential
 * boundary as sends. This is intentionally read-only; all outbound POSTs must
 * continue to go through sendSmsReminder so its kill-switches remain active.
 */
export async function getSmsMessageStatus(messageSid: string): Promise<{
  ok: boolean;
  status?: string;
  errorCode?: number | null;
  error?: string;
}> {
  const sid = messageSid.trim();
  if (!TWILIO_MESSAGE_SID_RE.test(sid)) {
    return { ok: false, error: "invalid_message_sid" };
  }

  const creds = await getTwilioSmsCreds();
  if (!creds) return { ok: false, error: "twilio_not_configured" };

  const auth = `Basic ${Buffer.from(
    `${creds.accountSid}:${creds.authToken}`,
  ).toString("base64")}`;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Messages/${encodeURIComponent(sid)}.json`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: auth },
    });
    if (!res.ok) return { ok: false, error: `twilio_${res.status}` };

    const json = await res.json() as { status?: unknown; error_code?: unknown };
    const status = typeof json.status === "string"
      ? json.status.trim().toLowerCase()
      : "";
    if (!TWILIO_MESSAGE_STATUSES.has(status)) {
      return { ok: false, error: "invalid_provider_status" };
    }
    const errorCode = typeof json.error_code === "number" && Number.isSafeInteger(json.error_code)
      ? json.error_code
      : null;
    return { ok: true, status, errorCode };
  } catch {
    return { ok: false, error: "provider_status_unavailable" };
  }
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
 * True when `e164` is a fictional / seed phone number that must NEVER receive a
 * real SMS — even in production.
 *
 * The North American Numbering Plan reserves the central-office code (exchange)
 * **555** for fictional use: it is not assignable to real subscribers, so any
 * `+1 NPA 555 XXXX` number is guaranteed test data (E2E seed numbers like
 * 604-555-0142, 604-555-1234, 604-555-2200 …). Blocking the whole 555 exchange
 * is therefore safe and catches every seed number, not just the narrow official
 * 555-0100..0199 fictional block.
 *
 * `e164` is the already-normalised "+<digits>" form from normaliseToE164.
 */
export function isFictionalTestNumber(e164: string): boolean {
  const digits = e164.replace(/[^\d]/g, "");
  // NANP: country code 1 + 10 national digits = "1AAANNNXXXX" (11 digits).
  if (digits.length === 11 && digits.startsWith("1")) {
    const exchange = digits.slice(4, 7); // NNN — the central-office code
    if (exchange === "555") return true;
  }
  return false;
}

/**
 * Outbound-SMS kill-switch. Returns a reason string when the message must be
 * SUPPRESSED (logged, no real Twilio call), or null when it may be sent.
 *
 * Layered guards — ANY match suppresses:
 *  (a) DISABLE_OUTBOUND_SMS env flag — manual / CI kill-switch.
 *  (b) NODE_ENV !== "production" — dev & test servers never send real SMS.
 *  (c) recipient is a fictional 555-exchange seed number — works even in
 *      production. This is the ONLY guard that stops an E2E run hitting a
 *      production server (where NODE_ENV=production, so (b) is bypassed) from
 *      billing real SMS to fake seed numbers.
 *  (d) caller marked the salon as a test/demo salon.
 *
 * Real customers on a production server are never affected: their numbers are
 * not in the 555 exchange and NODE_ENV is "production".
 */
export function smsSuppressReason(
  recipientE164: string,
  opts?: { salonIsTest?: boolean },
): string | null {
  const flag = process.env.DISABLE_OUTBOUND_SMS?.trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") {
    return "disabled_by_env";
  }
  // Demo/test mode: CI (e2e.yml) + local E2E (playwright webServer) always set
  // DEMO_OTP/NEXT_PUBLIC_DEMO_OTP. That flag only mocks OTP *receipt*; it never
  // gated *outbound* SMS, which is exactly how the booking-confirmation path
  // billed real Twilio under CI. Gating here closes that hole with the flag the
  // test envs already carry — no new var to remember. (Unset on production.)
  const demo = (process.env.DEMO_OTP ?? process.env.NEXT_PUBLIC_DEMO_OTP)
    ?.trim()
    .toLowerCase();
  if (demo === "true" || demo === "1") {
    return "demo_mode";
  }
  if (process.env.NODE_ENV !== "production") {
    return "non_production_env";
  }
  if (isFictionalTestNumber(recipientE164)) {
    return "fictional_test_number";
  }
  if (opts?.salonIsTest) {
    return "test_salon";
  }
  return null;
}

/**
 * Send an outbound SMS reminder.
 * @param toE164 - recipient phone; any accepted form (+country / bare NANP /
 *                 formatted) is normalised to strict E.164 before sending.
 * @param body   - message text (keep under 160 chars to avoid split)
 */
/**
 * Append a STOP opt-out line to EVERY customer SMS, exactly once. Centralised at
 * the single send chokepoint so no message type can ship without it — a CASL
 * (Canada) / TCPA (US) requirement. Idempotent: skipped when the body already
 * mentions STOP (messages that wrote their own line aren't doubled). STOP itself
 * is honoured carrier-side by Twilio Advanced Opt-Out.
 */
function withOptOut(body: string, lang?: "en" | "vi"): string {
  if (/\bSTOP\b/i.test(body)) return body;
  const line = lang === "vi" ? "Nhắn STOP để ngừng nhận tin." : "Reply STOP to opt out.";
  return `${body.trimEnd()}\n${line}`;
}

export async function sendSmsReminder(
  toE164: string,
  body: string,
  /** `statusCallbackUrl` for delivery receipts; `lang` localises the auto opt-out
   *  line; `salonIsTest` routes through the kill-switch. */
  opts: {
    salonId: string;
    statusCallbackUrl?: string;
    salonIsTest?: boolean;
    lang?: "en" | "vi";
  },
): Promise<{
  ok: boolean;
  messageSid?: string;
  error?: string;
  suppressed?: boolean;
  suppressionReason?: string;
}> {
  // Guarantee an opt-out on every customer SMS (idempotent — see withOptOut).
  body = withOptOut(body, opts.lang);

  // Normalise the recipient to E.164 — Twilio needs the leading "+".
  // Done BEFORE the kill-switch so the 555-exchange guard sees clean digits.
  const recipient = normaliseToE164(toE164);
  if (!recipient) {
    // Don't log the full number (PII) — only that normalisation failed.
    console.error("[sendSmsReminder] invalid recipient phone, cannot send (not E.164-normalisable)");
    return { ok: false, error: "invalid_phone" };
  }

  // ── KILL-SWITCH ─────────────────────────────────────────────────────
  // Suppress (log + fake SID, never bill Twilio) for disabled-env / non-prod /
  // fictional 555 seed numbers / test salons. Prevents E2E + dev from sending
  // real SMS — and stops an E2E run that hits production from billing seed
  // numbers, while real customers are never affected. See smsSuppressReason.
  const suppressReason = smsSuppressReason(recipient, { salonIsTest: opts.salonIsTest });
  if (suppressReason) {
    // Unique suffix: callers persist this SID into booking_notifications, whose
    // `twilio_message_sid` column is UNIQUE. A constant `SUPPRESSED_<reason>`
    // collided on the SECOND suppressed send, so every notification log after
    // the first silently failed its insert (in E2E/dev, and for 555 seed
    // numbers even in prod). The random suffix keeps the SID greppable while
    // guaranteeing uniqueness. A suppressed send has no real Twilio SID and
    // never receives a status webhook, so the value is otherwise opaque.
    const fakeSid = `SUPPRESSED_${suppressReason}_${crypto.randomUUID()}`;
    console.warn(`[sendSmsReminder] SUPPRESSED outbound SMS (${suppressReason}) — no real Twilio call`);
    return {
      ok: true,
      messageSid: fakeSid,
      suppressed: true,
      suppressionReason: suppressReason,
    };
  }

  // Durable NailIQ-side STOP/START state is checked immediately before the
  // provider boundary. Missing/malformed/unavailable truth fails closed; an
  // affirmative provider/salon suppression is treated as a successful no-send
  // so cron/worker callers can durably mark that notification handled.
  const { loadSmsOutboundSuppression } = await import(
    "@/shared/reminders/smsConsentSuppression"
  );
  const consent = await loadSmsOutboundSuppression({
    salonId: opts.salonId,
    phone: recipient,
  });
  if (consent.suppressed) {
    if (consent.reason === "consent_unavailable") {
      return { ok: false, error: "sms_consent_unavailable", suppressed: true, suppressionReason: consent.reason };
    }
    const fakeSid = `SUPPRESSED_${consent.reason}_${crypto.randomUUID()}`;
    return {
      ok: true,
      messageSid: fakeSid,
      suppressed: true,
      suppressionReason: consent.reason,
    };
  }

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
    To:   recipient,
    Body: body,
  };
  if (opts.statusCallbackUrl) {
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
