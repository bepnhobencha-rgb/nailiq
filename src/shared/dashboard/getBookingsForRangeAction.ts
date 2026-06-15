"use server";

import * as Sentry from "@sentry/nextjs";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { salonDayRangeUtc, salonYmdOfUtc } from "@/shared/lib/salonTime";
import type { BookingStatus } from "@/shared/types";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Slim booking record sufficient for calendar chips in Week / Month views.
 * Intentionally smaller than `SalonDashboardBooking` — we only fetch what
 * the calendar needs so the range query stays fast.
 */
export type CalendarBooking = {
  id: string;
  client_name: string;
  service_name: string;
  start_time_utc: string;
  status: Extract<BookingStatus, "pending" | "confirmed" | "in_progress" | "completed">;
};

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
// Salon-local YYYY-MM-DD derivation uses the shared `salonYmdOfUtc`.

const CALENDAR_STATUSES = ["pending", "confirmed", "in_progress", "completed"] as const;

// ─── Fast path (hint provided) ────────────────────────────────────────────────

/**
 * Fast auth path used when the caller already knows salonId + timezone.
 *
 * Steps:
 *   1. getUser() via server Supabase client (verifies the JWT with Auth server)
 *   2. In parallel:
 *      a. salon_members check → confirms user is a member of this salon
 *      b. bookings range query (service-role) → the actual calendar data
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
  const {
    data: { user },
  } = await userSupabase.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  // Step 2: membership check + bookings query — run in parallel.
  const serviceRole = createServiceRoleClient();

  const [memberRes, bookingsRes] = await Promise.all([
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
        `id, client_name, start_time_utc, status,
         services!bookings_service_id_fkey ( name )`,
      )
      .eq("salon_id", hint.salonId)
      .gte("start_time_utc", startUtc)
      .lt("start_time_utc", endUtc)
      .in("status", CALENDAR_STATUSES as unknown as string[])
      .order("start_time_utc", { ascending: true }),
  ]);

  // Auth gate: if membership check failed, reject (even if bookings loaded).
  if (memberRes.error || !memberRes.data) {
    return { ok: false, error: "unauthorized" };
  }

  if (bookingsRes.error) {
    console.error("[getBookingsForRangeAction/hint] bookings query", bookingsRes.error);
    return { ok: false, error: "server_error" };
  }

  return groupByDay(bookingsRes.data ?? [], hint.timezone);
}

// ─── Grouping helper ──────────────────────────────────────────────────────────

// Supabase FK joins can return an object, an array, or null depending on the
// relation cardinality. Use `unknown` here and narrow inside the loop.
function groupByDay(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Array<Record<string, any>>,
  timezone: string,
): Extract<GetBookingsForRangeResult, { ok: true }> {
  const days: Record<string, CalendarBooking[]> = {};
  for (const row of data) {
    const st = row.start_time_utc as string | null | undefined;
    if (!st) continue;
    const ymd = salonYmdOfUtc(st, timezone);
    if (!ymd) continue;
    // FK join `services` may come back as an object, a single-element array,
    // or null — normalise to a name string.
    const svcRaw = row.services as { name?: string } | { name?: string }[] | null;
    const svcName = (
      Array.isArray(svcRaw) ? svcRaw[0]?.name : svcRaw?.name
    )?.trim() ?? "";
    const booking: CalendarBooking = {
      id: row.id,
      client_name: String(row.client_name ?? "").trim(),
      service_name: svcName,
      start_time_utc: st,
      status: row.status as CalendarBooking["status"],
    };
    (days[ymd] ??= []).push(booking);
  }
  return { ok: true, days, timezone };
}

// ─── Server action ────────────────────────────────────────────────────────────

/**
 * Fetches all calendar-visible bookings for a salon-local date range in a
 * **single query** — replacing the N parallel `loadReceptionistCenterDataAction`
 * calls that Week / Month views previously made (7 and ~31 respectively).
 *
 * Performance profile (with hint — fast path):
 *   - 1 auth round-trip (getUser)
 *   - 1 membership check  ┐ parallel
 *   - 1 bookings SELECT   ┘
 *   Total: 2 sequential groups (~120ms) vs 4 sequential calls (~250ms)
 *
 * Performance profile (without hint — compat fallback):
 *   - 1 auth round-trip (getDashboardWriteClient: getUser → salon_members → salons)
 *   - 1 bookings SELECT
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
  return Sentry.startSpan(
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

      // Single range query — hits idx_bookings_calendar_range (salon_id, start_time_utc).
      // Service name is resolved via the FK join in one go (no extra round-trip).
      const { data, error } = await ctx.supabase
        .from("bookings")
        .select(
          `id, client_name, start_time_utc, status,
           services!bookings_service_id_fkey ( name )`,
        )
        .eq("salon_id", ctx.salon.id)
        .gte("start_time_utc", startUtc)
        .lt("start_time_utc", endUtc)
        .in("status", CALENDAR_STATUSES as unknown as string[])
        .order("start_time_utc", { ascending: true });

      if (error) {
        console.error("[getBookingsForRangeAction] bookings query", error);
        return { ok: false, error: "server_error" };
      }

      return groupByDay(data ?? [], timezone);
    },
  );
}
