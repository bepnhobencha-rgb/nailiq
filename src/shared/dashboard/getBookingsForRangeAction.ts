"use server";

import * as Sentry from "@sentry/nextjs";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { salonDayRangeUtc } from "@/shared/lib/salonTime";
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derive the salon-local YYYY-MM-DD for a UTC ISO string.
 * Uses `en-CA` locale because it reliably emits `YYYY-MM-DD` parts.
 */
function utcIsoToSalonYmd(utcIso: string, timezone: string): string {
  const ms = Date.parse(utcIso);
  if (Number.isNaN(ms)) return "";
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const CALENDAR_STATUSES = ["pending", "confirmed", "in_progress", "completed"] as const;

// ─── Server action ────────────────────────────────────────────────────────────

/**
 * Fetches all calendar-visible bookings for a salon-local date range in a
 * **single query** — replacing the N parallel `loadReceptionistCenterDataAction`
 * calls that Week / Month views previously made (7 and ~31 respectively).
 *
 * Performance profile:
 *   - 1 auth round-trip (getDashboardWriteClient)
 *   - 1 bookings SELECT with range filter, hitting idx_bookings_calendar_range
 *   - Result grouped client-side by salon-local date
 *
 * @param slug      Salon URL slug (used for auth)
 * @param startYmd  First day to include (salon-local YYYY-MM-DD, inclusive)
 * @param endYmd    Last day to include  (salon-local YYYY-MM-DD, inclusive)
 */
export async function getBookingsForRangeAction(
  slug: string,
  startYmd: string,
  endYmd: string,
): Promise<GetBookingsForRangeResult> {
  return Sentry.startSpan(
    {
      name: "getBookingsForRangeAction",
      op: "server_action",
      attributes: {
        "nailiq.slug": slug,
        "nailiq.startYmd": startYmd,
        "nailiq.endYmd": endYmd,
      },
    },
    async () => {
      const ctx = await getDashboardWriteClient(slug);
      if (!ctx) return { ok: false, error: "unauthorized" };

      const timezone = ctx.salon.timezone;
      if (!timezone) return { ok: false, error: "salon_not_found" };

      // UTC bounds: first instant of startYmd → first instant of the day
      // AFTER endYmd (exclusive upper bound used by the DB query).
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

      // Group by salon-local date. Missing keys = 0 bookings for that day.
      const days: Record<string, CalendarBooking[]> = {};
      for (const row of data ?? []) {
        const st = row.start_time_utc;
        if (!st) continue;
        const ymd = utcIsoToSalonYmd(st, timezone);
        if (!ymd) continue;
        const svcName =
          (row.services as { name?: string } | null)?.name?.trim() ?? "";
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
    },
  );
}
