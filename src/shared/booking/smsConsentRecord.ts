/**
 * SMS consent evidence (Twilio A2P 10DLC / TCPA / CASL).
 *
 * Server-only by intent: `ip` and `userAgent` are read off the incoming
 * request, never from its body. Self-reported consent evidence proves nothing.
 *
 * A record is written ONLY for a consent the customer gave themselves, in a
 * browser, by ticking the box. Staff-entered (desk) and voice bookings do not
 * produce one — a fabricated record is worse than an absent one in a dispute.
 */
import { createHash } from "node:crypto";
import { bookingEn } from "@/shared/i18n/booking/en";
import { bookingVi } from "@/shared/i18n/booking/vi";

export type SmsConsentSource = "public_booking" | "group_booking";

export type SmsConsentMeta = {
  ip: string;
  userAgent: string;
  version: string;
  text: string;
  lang: "en" | "vi";
  source: SmsConsentSource;
  groupId?: string;
};

/**
 * Derived from the disclosure copy itself, so it cannot drift: edit the
 * `smsConsent` string in `i18n/booking/{en,vi}.ts` and the version changes with
 * it. A hand-maintained constant would silently keep labelling new wording with
 * the old version — exactly the claim this field exists to make truthfully.
 */
/** The exact bytes the version hashes. Exported so the test asserts the
 *  derivation itself instead of restating the formula. */
export function smsConsentCorpus(): string {
  return `${bookingEn.smsConsent} ${bookingVi.smsConsent}`;
}

export const SMS_CONSENT_VERSION: string = createHash("sha256")
  .update(smsConsentCorpus())
  .digest("hex")
  .slice(0, 12);

/** Best-effort client IP. Vercel overwrites `x-forwarded-for` at the edge, so
 *  its first entry is the real client and is not caller-spoofable there. */
function clientIpFrom(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip") || "unknown";
}

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
  opts?: { groupId?: string; salonName?: string },
): SmsConsentMeta {
  const { lang, text } = smsConsentDisclosure(language);
  return {
    ip: clientIpFrom(req),
    userAgent: req.headers.get("user-agent") ?? "unknown",
    version: SMS_CONSENT_VERSION,
    // Store the sentence as the customer read it, salon name substituted. The
    // version still identifies the wording, since the name is not the wording.
    text: text.replace("{salon}", opts?.salonName ?? ""),
    lang,
    source,
    ...(opts?.groupId ? { groupId: opts.groupId } : {}),
  };
}
