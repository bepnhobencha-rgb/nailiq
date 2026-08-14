"use server";

/**
 * Availability engine — read-only server action used by the receptionist
 * walk-in form to decide whether a customer can be assigned immediately
 * or whether they should be queued (status='waiting').
 *
 * The queue is opt-in for the customer per the operational model: if
 * staff is free now, we render an "Assign immediately" affordance and
 * the booking is created in a confirmed/in-service state without ever
 * touching `status='waiting'`. The queue exists only when the customer
 * accepts waiting.
 *
 * Membership is gated via `getDashboardWriteClient`. The query window
 * is bounded to `now()..now()+4h` so this stays cheap during peak; the
 * receptionist polls via the existing realtime channel rather than
 * keeping a hot subscription on this endpoint.
 */

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import {
  buildCapabilityMap,
  filterStaffCapableForService,
} from "@/shared/booking/staffCapability";

const HORIZON_HOURS = 4;
const OVERLOAD_QUEUE_AHEAD = 3;
const OVERLOAD_BOOKINGS_NEXT_2H = 4;
/** Minutes a booking can run past its planned end before we flag the
 * staff as "running over" (medium-confidence). */
const RUNNING_OVER_GRACE_MINUTES = 5;
/** Minutes of overrun beyond which we drop confidence to low. */
const RUNNING_OVER_HEAVY_MINUTES = 15;

export type StaffAvailability = {
  staffId: string;
  staffName: string;
  /** Active booking right now (if any). Null when staff is free. */
  currentBooking: {
    bookingId: string;
    clientName: string;
    /** ISO end time we believe the seat will free up. May be later than
     * the original end_time_utc when the in-service booking is running
     * over. */
    endsAt: string;
  } | null;
  /** True when no booking currently occupies the staff's chair. */
  isAvailableNow: boolean;
  /**
   * Earliest UTC ISO string the staff can take the next walk-in. Equals
   * `now` when `isAvailableNow`; equals `currentBooking.endsAt` when
   * busy; null when overloaded beyond the 4h horizon.
   */
  estimatedReadyAt: string | null;
  /** Floored minutes from `now` until `estimatedReadyAt`. 0 when free. */
  waitMinutes: number;
  /** Count of `status='waiting'` walk-ins that already named this staff
   * (via `staff_request_note` or post-arrival assignment). Acts as a
   * tiebreaker when a customer asks for a specific staff. */
  queueAhead: number;
  /** Total bookings this staff holds in `now..now+2h`. Used both for
   * the overload signal and for workload balancing. */
  bookingsNext2h: number;
  /** True when the staff is heavily booked — receptionist sees a
   * "Heavy load" warning. */
  overloaded: boolean;
  /** Confidence in the wait estimate. */
  confidenceLevel: "high" | "medium" | "low";
  /**
   * Task #04-D FIX 16 — earliest UTC ISO of a future group
   * booking for this staff within the 4h horizon, or `null`
   * when none. Surfaced so the walk-in form can warn a
   * receptionist before assigning a customer to a staff who
   * has a group session starting in the next ~30 min — a
   * group session is harder to reshuffle than a single
   * booking, so the form prompts confirmation rather than
   * silently assigning.
   */
  nextGroupBookingAt: string | null;
};

export type AvailabilityResult =
  | { ok: false; error: "unauthorized" | "invalid_input" | "server_error" }
  | { ok: true; nowIso: string; staff: StaffAvailability[] };

type StaffRow = {
  id: string;
  name: string | null;
  status: string | null;
};

type BookingRow = {
  id: string;
  staff_id: string | null;
  client_name: string | null;
  status: string | null;
  start_time_utc: string | null;
  end_time_utc: string | null;
  staff_request_note: string | null;
  /** Non-null means this booking is part of a multi-member group
   * (column populated by `insert_group_bookings`). Walk-in
   * assignment warns the receptionist before stepping on a
   * group's window — see FIX 16. */
  group_id: string | null;
};

type StaffServiceRow = {
  staff_id: string;
  service_id: string;
};

/**
 * Returns availability for every active staff in the salon, optionally
 * filtered to staff capable of performing `serviceId`. Sorted by best
 * match (see ranking in `getBestStaffMatch`).
 */
export async function getStaffAvailability(
  slug: string,
  serviceId: string | null,
): Promise<AvailabilityResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  const supabase = ctx.supabase;
  const salonId = ctx.salon.id;
  const cleanService =
    typeof serviceId === "string" && serviceId.trim() ? serviceId.trim() : null;

  const now = new Date();
  const nowIso = now.toISOString();
  const horizonIso = new Date(
    now.getTime() + HORIZON_HOURS * 60 * 60 * 1000,
  ).toISOString();

  // Active staff only — pending/inactive can't take walk-ins (matches
  // the gate in `assignWalkinToSlot`).
  const staffRes = (await supabase
    .from("staff")
    .select("id, name, status")
    .eq("salon_id", salonId)
    .eq("status", "active")
    .is("deleted_at" as never, null)
    .order("name", { ascending: true })) as {
    data: StaffRow[] | null;
    error: unknown;
  };

  if (staffRes.error) {
    console.error("[availabilityEngine] staff", staffRes.error);
    return { ok: false, error: "server_error" };
  }
  let staffRows = staffRes.data ?? [];

  // Filter by the salon's durable capability mode. Legacy salons remain
  // all-capable until an owner configures capabilities; once configured, an
  // empty whitelist intentionally means nobody is eligible. Any read failure
  // blocks assignment rather than silently broadening permissions.
  if (cleanService && staffRows.length) {
    const [capResRaw, capabilityModeRes] = await Promise.all([
      supabase
        .from("staff_services")
        .select("staff_id, service_id")
        .in(
          "staff_id",
          staffRows.map((s) => s.id),
        )
        .eq("service_id", cleanService),
      supabase.rpc("salon_has_staff_services", { p_salon_id: salonId }),
    ]);
    const capRes = capResRaw as {
      data: StaffServiceRow[] | null;
      error: unknown;
    };
    if (capRes.error || capabilityModeRes.error) {
      console.error(
        "[availabilityEngine] staff capability",
        capRes.error ?? capabilityModeRes.error,
      );
      return { ok: false, error: "server_error" };
    }
    const capability = buildCapabilityMap(
      capRes.data ?? [],
      capabilityModeRes.data === true ? "whitelist" : "legacy_all",
    );
    staffRows = [
      ...filterStaffCapableForService(
        staffRows,
        capability,
        cleanService,
      ),
    ];
  }

  if (staffRows.length === 0) {
    return { ok: true, nowIso, staff: [] };
  }

  const staffIds = staffRows.map((s) => s.id);

  // One query for in-window bookings (covers "current booking",
  // "bookings next 2h", and the wait projection).
  const bookingsRes = (await supabase
    .from("bookings")
    .select(
      "id, staff_id, client_name, status, start_time_utc, end_time_utc, staff_request_note, group_id",
    )
    .eq("salon_id", salonId)
    .in("staff_id", staffIds)
    .in("status", ["confirmed", "in_progress"])
    .lte("start_time_utc", horizonIso)
    .is("deleted_at" as never, null)) as {
    data: BookingRow[] | null;
    error: unknown;
  };

  if (bookingsRes.error) {
    console.error("[availabilityEngine] bookings", bookingsRes.error);
    return { ok: false, error: "server_error" };
  }

  // Walk-in queue depth per staff (only customers who already named
  // this staff via `staff_request_note`). General queue customers are
  // not pinned to any staff and don't add to a per-staff queueAhead.
  const queueRes = (await supabase
    .from("bookings")
    .select("id, staff_request_note")
    .eq("salon_id", salonId)
    .eq("source", "walkin")
    .eq("status", "waiting")
    .is("deleted_at" as never, null)) as {
    data: { id: string; staff_request_note: string | null }[] | null;
    error: unknown;
  };
  if (queueRes.error) {
    console.error("[availabilityEngine] queue", queueRes.error);
  }
  const queueRows = queueRes.data ?? [];
  const queueAheadByStaffName = new Map<string, number>();
  for (const q of queueRows) {
    const note = (q.staff_request_note ?? "").toLowerCase().trim();
    if (!note) continue;
    for (const s of staffRows) {
      const lname = (s.name ?? "").toLowerCase().trim();
      if (lname && note.includes(lname)) {
        queueAheadByStaffName.set(
          s.id,
          (queueAheadByStaffName.get(s.id) ?? 0) + 1,
        );
        break;
      }
    }
  }

  const bookings = bookingsRes.data ?? [];
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const horizonMs = horizonIso ? Date.parse(horizonIso) : 0;
  const nowMs = now.getTime();

  const result: StaffAvailability[] = staffRows.map((s) => {
    const own = bookings.filter((b) => b.staff_id === s.id);

    // Current booking: the in_progress row (if any) OR the confirmed
    // row whose window covers `now`. We trust end_time_utc as the
    // canonical "ready at" until a future PR adds an explicit
    // `started_at` overrun signal.
    let currentBooking: StaffAvailability["currentBooking"] = null;
    let earliestReadyAt: number | null = null;
    let runningOverMin = 0;

    for (const b of own) {
      const startMs = b.start_time_utc ? Date.parse(b.start_time_utc) : NaN;
      const endMs = b.end_time_utc ? Date.parse(b.end_time_utc) : NaN;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

      const isInProgressNow = b.status === "in_progress" && endMs > nowMs;
      const isConfirmedAroundNow =
        b.status === "confirmed" && startMs <= nowMs && endMs > nowMs;

      if (isInProgressNow || isConfirmedAroundNow) {
        if (!currentBooking) {
          currentBooking = {
            bookingId: String(b.id),
            clientName: String(b.client_name ?? "").trim() || "—",
            endsAt: new Date(endMs).toISOString(),
          };
          earliestReadyAt = endMs;
        } else if (endMs > earliestReadyAt!) {
          earliestReadyAt = endMs;
          currentBooking.endsAt = new Date(endMs).toISOString();
        }
      }

      // Overrun heuristic: in_progress past planned end without a
      // completion. Bigger overrun = lower confidence.
      if (b.status === "in_progress" && endMs < nowMs) {
        const overrunMin = Math.floor((nowMs - endMs) / 60000);
        runningOverMin = Math.max(runningOverMin, overrunMin);
        // Push the ready-at projection out by the overrun gap so the
        // wait estimate isn't wildly optimistic.
        const projected = nowMs + Math.min(overrunMin, 30) * 60000;
        if (currentBooking == null) {
          currentBooking = {
            bookingId: String(b.id),
            clientName: String(b.client_name ?? "").trim() || "—",
            endsAt: new Date(projected).toISOString(),
          };
          earliestReadyAt = projected;
        }
      }
    }

    const isAvailableNow = currentBooking == null;

    // bookingsNext2h: any confirmed/in_progress that *starts* before
    // now+2h (we're projecting load, not just current chair state).
    const twoHourCutoff = nowMs + twoHoursMs;
    const bookingsNext2h = own.filter((b) => {
      const startMs = b.start_time_utc ? Date.parse(b.start_time_utc) : NaN;
      return Number.isFinite(startMs) && startMs <= twoHourCutoff;
    }).length;

    // Task #04-D FIX 16 — earliest upcoming group booking start
    // for this staff inside the 4h horizon (engine query window).
    // Only future starts count — a group booking already in
    // progress is covered by `currentBooking` and not a "watch
    // out, X is about to start" signal.
    let nextGroupBookingAtMs: number | null = null;
    for (const b of own) {
      if (!b.group_id) continue;
      const startMs = b.start_time_utc ? Date.parse(b.start_time_utc) : NaN;
      if (!Number.isFinite(startMs) || startMs <= nowMs) continue;
      if (nextGroupBookingAtMs === null || startMs < nextGroupBookingAtMs) {
        nextGroupBookingAtMs = startMs;
      }
    }

    const queueAhead = queueAheadByStaffName.get(s.id) ?? 0;

    const overloaded =
      queueAhead >= OVERLOAD_QUEUE_AHEAD ||
      bookingsNext2h >= OVERLOAD_BOOKINGS_NEXT_2H;

    let estimatedReadyAt: string | null = isAvailableNow
      ? nowIso
      : currentBooking?.endsAt ?? null;
    // Push past horizon → null (we can't responsibly project further).
    if (estimatedReadyAt && Date.parse(estimatedReadyAt) > horizonMs) {
      estimatedReadyAt = null;
    }

    const waitMinutes = (() => {
      if (isAvailableNow) return 0;
      if (!estimatedReadyAt) return HORIZON_HOURS * 60;
      return Math.max(
        0,
        Math.floor((Date.parse(estimatedReadyAt) - nowMs) / 60000),
      );
    })();

    let confidenceLevel: StaffAvailability["confidenceLevel"] = "high";
    if (runningOverMin >= RUNNING_OVER_HEAVY_MINUTES || overloaded) {
      confidenceLevel = "low";
    } else if (runningOverMin > RUNNING_OVER_GRACE_MINUTES) {
      confidenceLevel = "medium";
    }

    return {
      staffId: s.id,
      staffName: String(s.name ?? "").trim(),
      currentBooking,
      isAvailableNow,
      estimatedReadyAt,
      waitMinutes,
      queueAhead,
      bookingsNext2h,
      overloaded,
      confidenceLevel,
      nextGroupBookingAt:
        nextGroupBookingAtMs !== null
          ? new Date(nextGroupBookingAtMs).toISOString()
          : null,
    };
  });

  return { ok: true, nowIso, staff: rankStaff(result) };
}

/**
 * Returns the same shape as `getStaffAvailability` but ranked by best
 * match for an immediate walk-in. The caller can render the top entry
 * as the "Best Match (auto)" recommendation.
 */
export async function getBestStaffMatch(
  slug: string,
  serviceId: string | null,
): Promise<AvailabilityResult> {
  // The ranking is identical to getStaffAvailability — exposing this
  // as a separate function keeps the call sites self-documenting and
  // gives us room to diverge later (e.g. weight by historical
  // affinity from client_profiles.top_staff).
  return getStaffAvailability(slug, serviceId);
}

function rankStaff(rows: StaffAvailability[]): StaffAvailability[] {
  return [...rows].sort((a, b) => {
    if (a.isAvailableNow !== b.isAvailableNow) {
      return a.isAvailableNow ? -1 : 1;
    }
    if (a.waitMinutes !== b.waitMinutes) {
      return a.waitMinutes - b.waitMinutes;
    }
    if (a.queueAhead !== b.queueAhead) {
      return a.queueAhead - b.queueAhead;
    }
    if (a.bookingsNext2h !== b.bookingsNext2h) {
      return a.bookingsNext2h - b.bookingsNext2h;
    }
    return a.staffName.localeCompare(b.staffName);
  });
}
