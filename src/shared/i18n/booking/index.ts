/**
 * P0.1 — public booking i18n resolver. Picks between `bookingEn` and
 * `bookingVi` based on a UI cookie (`nq-booking-lang`) or the
 * `Accept-Language` header. Server-side only — the booking page is
 * `force-dynamic` so re-render after the cookie flips is automatic.
 */
import { cookies, headers } from "next/headers";
import { bookingEn, type BookingMessages } from "./en";
import { bookingVi } from "./vi";

export type BookingLanguage = "en" | "vi";

/** Cookie name used by the language toggle. Set by the client-side
 * toggle UI; read by `resolveBookingLanguage`. */
export const BOOKING_LANG_COOKIE = "nq-booking-lang";

export function parseBookingLanguage(raw: unknown): BookingLanguage {
  return raw === "en" ? "en" : "vi";
}

/** Server helper: pick booking locale from cookie → Accept-Language →
 * default. Primary market is Vietnam, so VI is the default when no
 * signal is present. */
export async function resolveBookingLanguage(): Promise<BookingLanguage> {
  const cookieStore = await cookies();
  const cookieVal = cookieStore.get(BOOKING_LANG_COOKIE)?.value;
  if (cookieVal === "en" || cookieVal === "vi") return cookieVal;

  const headerStore = await headers();
  const al = headerStore.get("accept-language") ?? "";
  // English explicitly preferred ahead of Vietnamese? Honor it.
  // Otherwise default to VI (primary market).
  if (/\ben\b/i.test(al) && !/\bvi\b/i.test(al)) return "en";
  return "vi";
}

export function getBookingMessages(lang: BookingLanguage): BookingMessages {
  return lang === "en" ? bookingEn : bookingVi;
}

export { bookingEn, bookingVi };
export type { BookingMessages };
