/**
 * Types + link builder for "appointments never closed out".
 *
 * Deliberately separate from `loadUnclosedBookings.ts`: that module imports the
 * service-role Supabase client at the top level, and the dashboard card is a
 * client component. Importing the href helper from there would drag a
 * server-only secret path into the browser bundle.
 */

export type UnclosedBooking = {
  id: string;
  clientName: string;
  /** Salon-local YYYY-MM-DD — required by the Front Desk deep link, which
   *  loads that day before it can open the drawer. */
  dateYmd: string;
  startTimeUtc: string;
  status: string;
};

export type UnclosedBookingsResult = {
  count: number;
  /** Newest first, capped — enough to act on without burying the reader. */
  items: UnclosedBooking[];
};

/**
 * Front Desk deep link that opens this booking's drawer. The `date` param is
 * required: the page loads that salon-local day first, and only then matches
 * the booking id — a link without it silently opens nothing.
 */
export function unclosedBookingHref(
  slug: string,
  b: Pick<UnclosedBooking, "id" | "dateYmd">,
): string {
  return `/dashboard/${slug}/center?date=${b.dateYmd}&booking=${b.id}`;
}
