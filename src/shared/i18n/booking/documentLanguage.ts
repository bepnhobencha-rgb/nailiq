export type BookingDocumentLanguage = "en" | "vi";

/** Cookie written by the public booking language toggle. */
export const BOOKING_LANG_COOKIE = "nq-booking-lang";

/** Request-only header written by NailIQ Proxy for public booking documents. */
export const BOOKING_DOCUMENT_LANGUAGE_HEADER =
  "x-nailiq-booking-document-language";

/**
 * Resolve the language hint that can be known before the root layout renders.
 * An explicit URL choice wins over the booking cookie. Unknown values are
 * ignored instead of being coerced to Vietnamese.
 */
export function resolveBookingDocumentLanguageHint(
  queryLanguage: string | null,
  cookieLanguage: string | null,
): BookingDocumentLanguage | null {
  if (queryLanguage === "en" || queryLanguage === "vi") {
    return queryLanguage;
  }
  if (cookieLanguage === "en" || cookieLanguage === "vi") {
    return cookieLanguage;
  }
  return null;
}
