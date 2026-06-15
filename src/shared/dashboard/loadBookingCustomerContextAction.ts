"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";

/**
 * Lazy "customer launchpad" context for the booking detail drawer.
 *
 * The grid-click drawer shows one booking; this action enriches it on open
 * with the facts a receptionist actually asks for:
 *   - WHO created the booking (manual desk entry → the staff member; online →
 *     no human actor) — read from the `booking_created` audit event.
 *   - The customer's ALLERGIES (safety) — from `customer_preferences`.
 *   - The customer's return CADENCE ("comes back every ~4 weeks") + the next
 *     suggested date — computed from real visit history (median gap), because
 *     the precomputed `customer_booking_patterns.recurrence_frequency_days`
 *     is unreliable (often 0). Also returns the usual service/staff so the
 *     desk can one-tap rebook at the customer's rhythm.
 *
 * Only the open booking is queried, so this stays cheap (no per-row joins on
 * the day load). Owner / admin / receptionist may read; nail_tech may not.
 */

export type BookingCustomerContext = {
  /** Resolved name of whoever created the booking (manual). Null for online
   *  self-bookings or when the actor can't be resolved to a staff name. */
  creatorName: string | null;
  /** Raw role of the creator (owner|admin|receptionist|senior|nail_tech). */
  creatorRole: string | null;
  /** True when the create event recorded no human actor (customer self-book). */
  isSelfBooked: boolean;
  /** Comma-joined allergy list; null when none recorded. */
  allergies: string | null;
  /** Median days between this customer's visits at this salon; null when too
   *  few visits to infer a rhythm (< 3). */
  cadenceDays: number | null;
  /** ISO of the customer's most recent visit (this salon). */
  lastVisitAt: string | null;
  /** ISO date suggested for the next booking (lastVisit + cadence). */
  nextSuggestedAt: string | null;
  /** Non-cancelled visit count at this salon. */
  visitCount: number;
  /** Usual service id for one-tap rebook prefill (most frequent). */
  usualServiceId: string | null;
  /** Usual staff id for one-tap rebook prefill (most frequent). */
  usualStaffId: string | null;
};

export type LoadBookingCustomerContextResult =
  | { ok: false; error: "unauthorized" | "forbidden" | "not_found" | "server_error" }
  | { ok: true; context: BookingCustomerContext };

const ACTIVE_VISIT_STATUSES = [
  "confirmed",
  "in_progress",
  "completed",
  "no_show",
];

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

export async function loadBookingCustomerContext(
  slug: string,
  bookingId: string,
): Promise<LoadBookingCustomerContextResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  // Front-desk roles only; a bookable-but-not-front-desk tech shouldn't pull
  // cross-booking customer history.
  if (ctx.role === "nail_tech") return { ok: false, error: "forbidden" };

  const id = (bookingId ?? "").trim();
  if (!id) return { ok: false, error: "not_found" };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[loadBookingCustomerContext] service role", e);
    return { ok: false, error: "server_error" };
  }

  // 1) The booking itself — scoped to this salon (authorization boundary).
  const { data: booking, error: bErr } = await admin
    .from("bookings")
    .select("id, salon_id, client_phone, client_profile_id")
    .eq("id", id)
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();

  if (bErr) {
    console.error("[loadBookingCustomerContext] booking", bErr);
    return { ok: false, error: "server_error" };
  }
  if (!booking) return { ok: false, error: "not_found" };

  const clientPhone = (booking.client_phone ?? "").trim() || null;
  const clientProfileId = booking.client_profile_id ?? null;

  // 2) Creator — earliest booking_created event for this booking.
  let creatorName: string | null = null;
  let creatorRole: string | null = null;
  let isSelfBooked = false;
  {
    const { data: ev } = await admin
      .from("booking_events")
      .select("actor_user_id, actor_role, created_at")
      .eq("booking_id", id)
      .eq("event_type", "booking_created")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (ev) {
      creatorRole = ev.actor_role ?? null;
      if (ev.actor_user_id) {
        const { data: staffRow } = await admin
          .from("staff")
          .select("name")
          .eq("user_id", ev.actor_user_id)
          .eq("salon_id", ctx.salon.id)
          .maybeSingle();
        creatorName = staffRow?.name?.trim() || null;
      } else {
        // No human actor recorded → customer self-booked (online/voice).
        isSelfBooked = true;
      }
    }
  }

  // 3) Allergies — from the customer's salon-scoped preferences.
  let allergies: string | null = null;
  if (clientProfileId) {
    const { data: pref } = await admin
      .from("customer_preferences")
      .select("allergies")
      .eq("client_profile_id", clientProfileId)
      .eq("salon_id", ctx.salon.id)
      .maybeSingle();
    const arr = (pref?.allergies ?? null) as string[] | null;
    if (Array.isArray(arr) && arr.length > 0) {
      const cleaned = arr.map((a) => String(a).trim()).filter(Boolean);
      allergies = cleaned.length ? cleaned.join(", ") : null;
    }
  }

  // 4) Cadence + usual service/staff — from real visit history (phone-keyed).
  let cadenceDays: number | null = null;
  let lastVisitAt: string | null = null;
  let nextSuggestedAt: string | null = null;
  let visitCount = 0;
  let usualServiceId: string | null = null;
  let usualStaffId: string | null = null;

  if (clientPhone) {
    const { data: visits } = await admin
      .from("bookings")
      .select("start_time_utc, service_id, staff_id")
      .eq("salon_id", ctx.salon.id)
      .eq("client_phone", clientPhone)
      .in("status", ACTIVE_VISIT_STATUSES)
      .order("start_time_utc", { ascending: true })
      .limit(50);

    const rows = (visits ?? []).filter((v) => v.start_time_utc);
    visitCount = rows.length;

    // Most-frequent service / staff for the rebook prefill.
    const tally = (key: "service_id" | "staff_id"): string | null => {
      const counts = new Map<string, number>();
      for (const r of rows) {
        const v = (r[key] as string | null) ?? null;
        if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      let best: string | null = null;
      let bestN = 0;
      for (const [v, n] of counts) {
        if (n > bestN) {
          best = v;
          bestN = n;
        }
      }
      return best;
    };
    usualServiceId = tally("service_id");
    usualStaffId = tally("staff_id");

    if (rows.length > 0) {
      lastVisitAt = rows[rows.length - 1].start_time_utc as string;

      // Distinct visit DAYS → gaps in days → median cadence.
      const dayMs = 24 * 60 * 60 * 1000;
      const days = Array.from(
        new Set(
          rows.map((r) =>
            Math.floor(Date.parse(r.start_time_utc as string) / dayMs),
          ),
        ),
      ).sort((a, b) => a - b);

      if (days.length >= 3) {
        const gaps: number[] = [];
        for (let i = 1; i < days.length; i++) {
          const g = days[i] - days[i - 1];
          // Ignore same-day duplicates and implausibly long lapses (> 6 months).
          if (g >= 1 && g <= 183) gaps.push(g);
        }
        const m = median(gaps);
        if (m && m >= 1) {
          cadenceDays = m;
          nextSuggestedAt = new Date(
            Date.parse(lastVisitAt) + m * dayMs,
          ).toISOString();
        }
      }
    }
  }

  return {
    ok: true,
    context: {
      creatorName,
      creatorRole,
      isSelfBooked,
      allergies,
      cadenceDays,
      lastVisitAt,
      nextSuggestedAt,
      visitCount,
      usualServiceId,
      usualStaffId,
    },
  };
}
