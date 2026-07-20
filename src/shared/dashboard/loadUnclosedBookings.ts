import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { salonYmdOfUtc } from "@/shared/lib/salonTime";
import type { UnclosedBookingsResult } from "@/shared/dashboard/unclosedBookingTypes";

/**
 * Bookings whose appointment is well past but whose status was never closed
 * out — the desk never tapped complete / no-show, so they sit as `confirmed`,
 * `pending` or `in_progress` forever.
 *
 * Why this matters beyond tidiness: every one of these is missing revenue in
 * the reports and a missing entry in the no-show rate, so the numbers the owner
 * makes decisions on drift further from reality each day.
 *
 * Shared deliberately: the dashboard nudge and Minh's evening digest must agree
 * on the count, or the owner sees "8 to review" in one place and a different
 * number in the other and stops trusting both.
 */

/** Long enough that the service certainly finished. Matches the auto-close
 *  sweep in /api/cron/close-stale-in-progress so the two never disagree. */
const STALE_AFTER_HOURS = 12;
/** Past this the owner no longer remembers the visit well enough to judge it,
 *  and an unbounded list only ever grows. */
const LOOKBACK_DAYS = 30;

/**
 * Channels whose source of truth is another system. Tech Nails works in Wix and
 * Hi-Lite Head Spa in Square; their bookings sync INTO NailIQ but nobody closes
 * them out here because this is not where they work. Counting those turned a
 * useful nudge into 455 false alarms at Tech Nails alone — and blamed staff for
 * something structural.
 */
const EXTERNAL_CHANNELS = ["wix", "square"] as const;

const EMPTY: UnclosedBookingsResult = { count: 0, items: [] };

export async function loadUnclosedBookings(
  salonId: string,
  timezone: string,
  opts?: { limit?: number },
): Promise<UnclosedBookingsResult> {
  if (!salonId) return EMPTY;
  const limit = opts?.limit ?? 10;

  let db: ReturnType<typeof createServiceRoleClient>;
  try {
    db = createServiceRoleClient();
  } catch {
    return EMPTY;
  }

  const now = Date.now();
  const staleBefore = new Date(
    now - STALE_AFTER_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const lookbackAfter = new Date(
    now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await db
    .from("bookings")
    .select("id, client_name, start_time_utc, status, booking_channel")
    .eq("salon_id", salonId)
    .in("status", ["pending", "confirmed", "in_progress"])
    .lt("end_time_utc", staleBefore)
    .gte("end_time_utc", lookbackAfter)
    .order("start_time_utc", { ascending: false })
    .limit(200);

  if (error) {
    console.error("[loadUnclosedBookings]", error);
    return EMPTY;
  }

  const rows = (data ?? []) as {
    id: string;
    client_name: string | null;
    start_time_utc: string | null;
    status: string;
    booking_channel: string | null;
  }[];

  // Filtered here rather than in the query: `booking_channel` is NULL for desk
  // bookings, and PostgREST's `not.in` drops NULL rows too — which would hide
  // exactly the front-desk bookings this nudge exists to catch.
  const owned = rows.filter(
    (r) =>
      !r.booking_channel ||
      !EXTERNAL_CHANNELS.includes(
        r.booking_channel as (typeof EXTERNAL_CHANNELS)[number],
      ),
  );

  return {
    count: owned.length,
    items: owned.slice(0, limit).map((r) => ({
      id: r.id,
      clientName: r.client_name?.trim() || "—",
      dateYmd: r.start_time_utc ? salonYmdOfUtc(r.start_time_utc, timezone) : "",
      startTimeUtc: r.start_time_utc ?? "",
      status: r.status,
    })),
  };
}
