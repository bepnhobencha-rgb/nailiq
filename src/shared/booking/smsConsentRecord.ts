/**
 * SMS consent evidence (Twilio A2P 10DLC / TCPA / CASL).
 *
 * Server-only: reads the client IP and user agent off the incoming request.
 * `submitPublicBooking` / `submitGroupBooking` run in the browser, so the
 * request that reaches `/api/booking/sms-confirm` carries the customer's real
 * IP and UA. Never accept either from the request body — self-reported consent
 * evidence proves nothing.
 */
import { bookingEn } from "@/shared/i18n/booking/en";
import { bookingVi } from "@/shared/i18n/booking/vi";
import { clientIp } from "@/shared/lib/inAppRateLimit";

/**
 * Bump whenever `smsConsent` copy in `src/shared/i18n/booking/{en,vi}.ts`
 * changes. A stored record must say which wording the customer actually saw.
 */
export const SMS_CONSENT_VERSION = "2026-07-08.v1";

export type SmsConsentSource = "public_booking" | "group_booking";

export type SmsConsentMeta = {
  ip: string;
  userAgent: string;
  version: string;
  text: string;
  lang: "en" | "vi";
  source: SmsConsentSource;
};

/** The disclosure exactly as rendered to the customer, resolved server-side. */
export function smsConsentDisclosure(language: string | null | undefined): {
  lang: "en" | "vi";
  text: string;
} {
  const lang = language === "en" ? "en" : "vi";
  return { lang, text: lang === "en" ? bookingEn.smsConsent : bookingVi.smsConsent };
}

export function buildSmsConsentMeta(
  req: Request,
  language: string | null | undefined,
  source: SmsConsentSource,
): SmsConsentMeta {
  const { lang, text } = smsConsentDisclosure(language);
  return {
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent") ?? "unknown",
    version: SMS_CONSENT_VERSION,
    text,
    lang,
    source,
  };
}
