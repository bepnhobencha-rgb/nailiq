/**
 * Single source of truth for "what language do we message this customer in?"
 *
 * Policy (agreed with Huy, 2026-06-13):
 *   - A customer who booked ONLINE picked a site language; we captured it as
 *     `bookings.client_locale`. Always honor that — it's their explicit choice.
 *   - A remembered `customer_preferences.preferred_language` is next.
 *   - Otherwise (staff/desk-created bookings with no signal) fall back to the
 *     salon's default, which itself defaults to ENGLISH. So staff-initiated
 *     create / reschedule / cancel notifications go out in English unless the
 *     customer's own online choice says otherwise.
 *
 * This replaces the old hardcoded `"vi"` fallback scattered across the SMS
 * paths. Keep it dependency-free so the Deno edge function (reschedule-sms)
 * can mirror the same order.
 */

export type SupportedLocale = "en" | "vi";

/** Global default when nothing else is known — English, per the policy above. */
export const DEFAULT_CUSTOMER_LOCALE: SupportedLocale = "en";

function normalizeLocale(value: string | null | undefined): SupportedLocale | null {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "en" || v.startsWith("en-")) return "en";
  if (v === "vi" || v.startsWith("vi-")) return "vi";
  return null;
}

export interface ResolveCustomerLocaleInput {
  /** `bookings.client_locale` — the site language the customer chose when they
   *  booked online. Null for staff/desk-created bookings. */
  clientLocale?: string | null;
  /** `customer_preferences.preferred_language` for this phone + salon. */
  preferredLanguage?: string | null;
  /** `salons.default_notification_locale` — per-salon default; itself defaults
   *  to English when unset. */
  salonDefaultLocale?: string | null;
}

/**
 * Resolve the locale to message a customer in, following the agreed priority.
 * Always returns a supported locale (never null).
 */
export function resolveCustomerLocale(
  input: ResolveCustomerLocaleInput,
): SupportedLocale {
  return (
    normalizeLocale(input.clientLocale) ??
    normalizeLocale(input.preferredLanguage) ??
    normalizeLocale(input.salonDefaultLocale) ??
    DEFAULT_CUSTOMER_LOCALE
  );
}
