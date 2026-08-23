"use server";

import * as ErrorReporter from "@/shared/observability/errorReporter";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { requireActiveAuthSession } from "@/shared/auth/requireActiveAuthSession";
import { salonDayRangeUtc } from "@/shared/lib/salonTime";
import {
  CALENDAR_STATUSES,
  groupCalendarRowsByDay,
  type CalendarBooking,
  type SequenceCalendarRow,
} from "@/shared/dashboard/calendarBookingRows";

export type { CalendarBooking } from "@/shared/dashboard/calendarBookingRows";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Slim booking record sufficient for calendar chips in Week / Month views.
 * Intentionally smaller than `SalonDashboardBooking` — we only fetch what
 * the calendar needs so the range query stays fast.
 */
export type GetBookingsForRangeResult =
  | {
      ok: true;
      /**
       * Bookings keyed by salon-local YYYY-MM-DD.
       * Only dates with ≥1 booking are present — callers should treat
       * missing keys as empty arrays.
       */
      days: Record<string, CalendarBooking[]>;
      /** IANA timezone for the salon — needed by the caller to map
       *  start_time_utc to a display time without a second fetch. */
      timezone: string;
    }
  | { ok: false; error: string };

/**
 * Pre-resolved context from the parent page (SSR).
 * When provided, the action skips the 3-call getDashboardWriteClient chain
 * (getUser → salon_members → salons SELECT) and instead only does:
 *   1. getUser()                                — verify authentication
 *   2. memberCheck(userId, salonId) in parallel  — verify membership
 *      + bookings range query       in parallel  — the actual data
 *
 * This cuts 4 sequential round-trips → 2, saving ~40% latency on every
 * week/month navigation event.
 */
export type BookingsRangeHint = {
  /** UUID of the salon — already resolved by the SSR page. */
  salonId: string;
  /** IANA timezone — already on the salon row from SSR. */
  timezone: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
// ─── Fast path (hint provided) ────────────────────────────────────────────────

/**
 * Fast auth path used when the caller already knows salonId + timezone.
 *
 * Steps:
 *   1. getUser() via server Supabase client (verifies the JWT with Auth server)
 *   2. In parallel:
 *      a. salon_members check → confirms user is a member of this salon
 *      b. bounded parent + segment reads (service-role) → calendar data
 *
 * The service-role client is safe here because we verify membership in
 * parallel before returning data, and the check is server-side.
 */
async function fetchWithHint(
  hint: BookingsRangeHint,
  startUtc: string,
  endUtc: string,
): Promise<GetBookingsForRangeResult> {
  // Step 1: verify the user is authenticated.
  const userSupabase = await createClient();
  const session = await requireActiveAuthSession(userSupabase);
  if (!session.ok) return { ok: false, error: "unauthorized" };
  const user = session.user;

  // Step 2: membership check + bookings query — run in parallel.
  const serviceRole = createServiceRoleClient();

  const [memberRes, bookingsRes, segmentsRes] = await Promise.all([
    // 2a. Verify user is a member of this salon.
    userSupabase
      .from("salon_members")
      .select("salon_id")
      .eq("user_id", user.id)
      .eq("salon_id", hint.salonId)
      .maybeSingle(),

    // 2b. Fetch calendar bookings for the range.
    serviceRole
      .from("bookings")
      .select(
        `id, client_name, start_time_utc, end_time_utc, staff_id, resource_id,
         status, schedule_model,
         services!bookings_service_id_fkey ( name )`,
      )
      .eq("salon_id", hint.salonId)
      .eq("schedule_model", "single")
      .gte("start_time_utc", startUtc)
      .lt("start_time_utc", endUtc)
      .in("status", CALENDAR_STATUSES as unknown as string[])
      .order("start_time_utc", { ascending: true }),

    serviceRole
      .from("booking_service_segments" as never)
      .select(
        `id, booking_id, salon_id, position, staff_id, resource_id, service_name,
         customer_start_utc, customer_end_utc, occupied_start_utc,
         occupied_end_utc, prep_minutes, reservation_status,
         booking:bookings!inner(client_name, status, deleted_at, schedule_model)`,
      )
      .eq("salon_id" as never, hint.salonId as never)
      .eq("booking.salon_id" as never, hint.salonId as never)
      .eq("booking.schedule_model" as never, "segments_v1" as never)
      .is("booking.deleted_at" as never, null)
      .lt("customer_start_utc" as never, endUtc as never)
      .gte("customer_start_utc" as never, startUtc as never)
      .in("reservation_status" as never, CALENDAR_STATUSES as unknown as never)
      .order("customer_start_utc" as never, { ascending: true }),
  ]);

  // Auth gate: if membership check failed, reject (even if bookings loaded).
  if (memberRes.error || !memberRes.data) {
    return { ok: false, error: "unauthorized" };
  }

  if (bookingsRes.error) {
    console.error("[getBookingsForRangeAction/hint] bookings query", bookingsRes.error);
    return { ok: false, error: "server_error" };
  }
  if (segmentsRes.error) {
    console.error("[getBookingsForRangeAction/hint] sequence segments query", segmentsRes.error);
    return { ok: false, error: "server_error" };
  }

  return groupCalendarRowsByDay(
    bookingsRes.data ?? [],
    (segmentsRes.data ?? []) as unknown as SequenceCalendarRow[],
    hint.timezone,
  );
}

// ─── Server action ────────────────────────────────────────────────────────────

/**
 * Fetches all calendar-visible bookings for a salon-local date range in a
 * **two bounded capacity reads** — replacing the N parallel `loadReceptionistCenterDataAction`
 * calls that Week / Month views previously made (7 and ~31 respectively).
 *
 * Performance profile (with hint — fast path):
 *   - 1 auth round-trip (getUser)
 *   - 1 membership check       ┐ parallel
 *   - parent + segment SELECTs ┘
 *   Total: 2 sequential groups (~120ms) vs 4 sequential calls (~250ms)
 *
 * Performance profile (without hint — compat fallback):
 *   - 1 auth round-trip (getDashboardWriteClient: getUser → salon_members → salons)
 *   - parent + segment SELECTs in parallel
 *   Total: 4 sequential round-trips (~250ms)
 *
 * @param slug      Salon URL slug (used for auth when hint is absent)
 * @param startYmd  First day to include (salon-local YYYY-MM-DD, inclusive)
 * @param endYmd    Last day to include  (salon-local YYYY-MM-DD, inclusive)
 * @param hint      Optional pre-resolved context from the SSR parent to use
 *                  the fast path. Pass `{ salonId, timezone }` from the
 *                  ReceptionistCenter props.
 */
export async function getBookingsForRangeAction(
  slug: string,
  startYmd: string,
  endYmd: string,
  hint?: BookingsRangeHint,
): Promise<GetBookingsForRangeResult> {
  return ErrorReporter.startSpan(
    {
      name: "getBookingsForRangeAction",
      op: "server_action",
      attributes: {
        "nailiq.slug": slug,
        "nailiq.startYmd": startYmd,
        "nailiq.endYmd": endYmd,
        "nailiq.hint": hint ? "yes" : "no",
      },
    },
    async () => {
      // ── Fast path: hint provided (salonId + timezone already known) ──────────
      if (hint) {
        let startUtc: string;
        let endUtc: string;
        try {
          ({ startUtc } = salonDayRangeUtc(startYmd, hint.timezone));
          ({ endUtc } = salonDayRangeUtc(endYmd, hint.timezone));
        } catch (e) {
          console.error("[getBookingsForRangeAction] salonDayRangeUtc (hint)", e);
          return { ok: false, error: "invalid_date" };
        }
        return fetchWithHint(hint, startUtc, endUtc);
      }

      // ── Compat fallback: no hint — full 3-call getDashboardWriteClient chain ─
      const ctx = await getDashboardWriteClient(slug);
      if (!ctx) return { ok: false, error: "unauthorized" };

      const timezone = ctx.salon.timezone;
      if (!timezone) return { ok: false, error: "salon_not_found" };

      let startUtc: string;
      let endUtc: string;
      try {
        ({ startUtc } = salonDayRangeUtc(startYmd, timezone));
        ({ endUtc } = salonDayRangeUtc(endYmd, timezone));
      } catch (e) {
        console.error("[getBookingsForRangeAction] salonDayRangeUtc", e);
        return { ok: false, error: "invalid_date" };
      }

      // Two bounded capacity reads: legacy single-row bookings plus authoritative
      // sequence segments. Service names are resolved in the same parallel group.
      // The segment table is deliberately service-role-only; authorization and
      // tenant identity above came from getDashboardWriteClient, never the caller.
      const serviceRole = createServiceRoleClient();
      const [bookingsRes, segmentsRes] = await Promise.all([
        ctx.supabase
        .from("bookings")
        .select(
          `id, client_name, start_time_utc, end_time_utc, staff_id, resource_id,
           status, schedule_model,
           services!bookings_service_id_fkey ( name )`,
        )
        .eq("salon_id", ctx.salon.id)
        .eq("schedule_model", "single")
        .gte("start_time_utc", startUtc)
        .lt("start_time_utc", endUtc)
        .in("status", CALENDAR_STATUSES as unknown as string[])
        .order("start_time_utc", { ascending: true }),
        serviceRole
          .from("booking_service_segments" as never)
          .select(
            `id, booking_id, salon_id, position, staff_id, resource_id, service_name,
             customer_start_utc, customer_end_utc, occupied_start_utc,
             occupied_end_utc, prep_minutes, reservation_status,
             booking:bookings!inner(client_name, status, deleted_at, schedule_model)`,
          )
          .eq("salon_id" as never, ctx.salon.id as never)
          .eq("booking.salon_id" as never, ctx.salon.id as never)
          .eq("booking.schedule_model" as never, "segments_v1" as never)
          .is("booking.deleted_at" as never, null)
          .lt("customer_start_utc" as never, endUtc as never)
          .gte("customer_start_utc" as never, startUtc as never)
          .in("reservation_status" as never, CALENDAR_STATUSES as unknown as never)
          .order("customer_start_utc" as never, { ascending: true }),
      ]);

      if (bookingsRes.error || segmentsRes.error) {
        console.error("[getBookingsForRangeAction] calendar query", {
          bookings: bookingsRes.error,
          segments: segmentsRes.error,
        });
        return { ok: false, error: "server_error" };
      }

      return groupCalendarRowsByDay(
        bookingsRes.data ?? [],
        (segmentsRes.data ?? []) as unknown as SequenceCalendarRow[],
        timezone,
      );
    },
  );
}
