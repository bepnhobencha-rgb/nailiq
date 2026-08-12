export type BookingLanguage = "en" | "vi";

/**
 * Returns a same-page booking URL with the selected language while preserving
 * preview, try-on and other booking query parameters plus the current hash.
 */
export function bookingLanguagePath(
  currentHref: string,
  language: BookingLanguage,
): string {
  const url = new URL(currentHref);
  url.searchParams.set("lang", language);

  return `${url.pathname}${url.search}${url.hash}`;
}
