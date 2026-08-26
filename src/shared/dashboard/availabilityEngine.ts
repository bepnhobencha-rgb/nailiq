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
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

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
    reservationId: string;
    clientName: string;
    /** ISO end time we believe the seat will free up. May be later than
     * the original end_time_utc when the in-service booking is running
     * over. */
    endsAt: string;
    scheduleModel: "single" | "segments_v1";
    segmentId: string | null;
    staffId: string;
    resourceId: string | null;
    prepMinutes: number;
    serviceStartsAt: string;
    serviceEndsAt: string;
    occupiedStartsAt: string;
    occupiedEndsAt: string;
  } | null;
  /** Exact persisted capacity reservations in the bounded operational window. */
  reservations: StaffCapacityReservation[];
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

export type StaffCapacityReservation = {
  reservationId: string;
  bookingId: string;
  scheduleModel: "single" | "segments_v1";
  segmentId: string | null;
  clientName: string;
  status: string;
  staffId: string;
  resourceId: string | null;
  prepMinutes: number;
  serviceStartsAt: string;
  serviceEndsAt: string;
  occupiedStartsAt: string;
  occupiedEndsAt: string;
  groupId: string | null;
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
  reservation_id: string;
  schedule_model: "single" | "segments_v1";
  segment_id: string | null;
  staff_id: string | null;
  resource_id: string | null;
  client_name: string | null;
  status: string | null;
  prep_minutes: number;
  start_time_utc: string | null;
  end_time_utc: string | null;
  service_start_time_utc: string | null;
  service_end_time_utc: string | null;
  staff_request_note: string | null;
  /** Non-null means this booking is part of a multi-member group
   * (column populated by `insert_group_bookings`). Walk-in
   * assignment warns the receptionist before stepping on a
   * group's window — see FIX 16. */
  group_id: string | null;
};

type SequenceAvailabilityRow = {
  id: string;
  booking_id: string;
  staff_id: string;
  resource_id: string | null;
  prep_minutes: number;
  customer_start_utc: string;
  customer_end_utc: string;
  occupied_start_utc: string;
  occupied_end_utc: string;
  reservation_status: string;
  booking:
    | { client_name?: string | null; group_id?: string | null; schedule_model?: string | null }
    | Array<{ client_name?: string | null; group_id?: string | null; schedule_model?: string | null }>
    | null;
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
  // booking_service_segments is intentionally service-role-only. Membership
  // has already been derived server-side by getDashboardWriteClient, so use a
  // privileged client only for that tenant-scoped capacity read rather than
  // exposing the table to authenticated browser roles.
  const serviceRole = createServiceRoleClient();
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

  // Filter by skill/capability when a service is selected. Staff with
  // an empty `staff_services` mapping fall back to "can do anything"
  // (consistent with the existing assign flow's permissive default).
  if (cleanService && staffRows.length) {
    const capRes = (await supabase
      .from("staff_services")
      .select("staff_id, service_id")
      .in(
        "staff_id",
        staffRows.map((s) => s.id),
      )
      .eq("service_id", cleanService)) as {
      data: StaffServiceRow[] | null;
      error: unknown;
    };
    if (capRes.error) {
      console.error("[availabilityEngine] staff_services", capRes.error);
      // Soft-fail: surface all active staff rather than block the form.
    } else if ((capRes.data?.length ?? 0) > 0) {
      // Only constrain when at least one mapping exists for this
      // service. If no mapping rows came back at all, treat the whole
      // salon as capable (tiny salons often skip the mapping step).
      const allowed = new Set(capRes.data!.map((r) => r.staff_id));
      const constrained = staffRows.filter((s) => allowed.has(s.id));
      if (constrained.length > 0) staffRows = constrained;
    }
  }

  if (staffRows.length === 0) {
    return { ok: true, nowIso, staff: [] };
  }

  const staffIds = staffRows.map((s) => s.id);

  // Parallel capacity reads for legacy single bookings and authoritative
  // sequence segments (covers current booking, 2h load, and wait projection).
  const [bookingsRes, segmentsRes] = await Promise.all([
    supabase
      .from("bookings")
      .select(
        "id, staff_id, resource_id, client_name, status, start_time_utc, end_time_utc, staff_request_note, group_id, schedule_model",
      )
      .eq("salon_id", salonId)
      .eq("schedule_model", "single")
      .in("staff_id", staffIds)
      .in("status", ["confirmed", "in_progress"])
      .lte("start_time_utc", horizonIso)
      .or(`status.eq.in_progress,end_time_utc.gte.${nowIso}`)
      .is("deleted_at" as never, null),
    serviceRole
      .from("booking_service_segments" as never)
      .select(
        `id, booking_id, salon_id, staff_id, resource_id, prep_minutes,
         customer_start_utc, customer_end_utc, occupied_start_utc,
         occupied_end_utc, reservation_status,
         booking:bookings!inner(client_name, group_id, deleted_at, schedule_model)`,
      )
      .eq("salon_id" as never, salonId as never)
      .eq("booking.salon_id" as never, salonId as never)
      .eq("booking.schedule_model" as never, "segments_v1" as never)
      .is("booking.deleted_at" as never, null)
      .in("staff_id" as never, staffIds as never)
      .in("reservation_status" as never, ["confirmed", "in_progress"] as never)
      .lte("occupied_start_utc" as never, horizonIso as never)
      .or(
        `reservation_status.eq.in_progress,occupied_end_utc.gte.${nowIso}` as never,
      ),
  ]);

  if (bookingsRes.error || segmentsRes.error) {
    console.error("[availabilityEngine] capacity reservations", {
      bookings: bookingsRes.error,
      segments: segmentsRes.error,
    });
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

  const singleBookings: BookingRow[] = ((bookingsRes.data ?? []) as Array<{
    id: string;
    staff_id: string | null;
    resource_id: string | null;
    client_name: string | null;
    status: string | null;
    start_time_utc: string | null;
    end_time_utc: string | null;
    staff_request_note: string | null;
    group_id: string | null;
    schedule_model?: string | null;
  }>).filter((row) => (
    (row.schedule_model == null || row.schedule_model === "single") &&
    (row.status === "in_progress" || Date.parse(row.end_time_utc ?? "") >= now.getTime())
  )).map((row) => ({
    ...row,
    reservation_id: row.id,
    schedule_model: "single",
    segment_id: null,
    prep_minutes: 0,
    service_start_time_utc: row.start_time_utc,
    service_end_time_utc: row.end_time_utc,
  }));
  const sequenceBookings: BookingRow[] = ((segmentsRes.data ?? []) as unknown as SequenceAvailabilityRow[])
    .flatMap((row) => {
      const parent = Array.isArray(row.booking) ? row.booking[0] : row.booking;
      if (
        !parent || parent.schedule_model !== "segments_v1" ||
        (
          row.reservation_status !== "in_progress" &&
          Date.parse(row.occupied_end_utc) < now.getTime()
        )
      ) return [];
      return [{
        id: row.booking_id,
        reservation_id: row.id,
        schedule_model: "segments_v1" as const,
        segment_id: row.id,
        staff_id: row.staff_id,
        resource_id: row.resource_id,
        client_name: parent.client_name ?? null,
        status: row.reservation_status,
        prep_minutes: row.prep_minutes,
        start_time_utc: row.occupied_start_utc,
        end_time_utc: row.occupied_end_utc,
        service_start_time_utc: row.customer_start_utc,
        service_end_time_utc: row.customer_end_utc,
        staff_request_note: null,
        group_id: parent.group_id ?? null,
      }];
    });
  const bookings = [...singleBookings, ...sequenceBookings];
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const horizonMs = horizonIso ? Date.parse(horizonIso) : 0;
  const nowMs = now.getTime();

  const result: StaffAvailability[] = staffRows.map((s) => {
    const own = bookings.filter((b) => b.staff_id === s.id);
    const reservations: StaffCapacityReservation[] = own.flatMap((b) => {
      if (
        !b.start_time_utc || !b.end_time_utc ||
        !b.service_start_time_utc || !b.service_end_time_utc || !b.staff_id
      ) return [];
      return [{
        reservationId: b.reservation_id,
        bookingId: b.id,
        scheduleModel: b.schedule_model,
        segmentId: b.segment_id,
        clientName: String(b.client_name ?? "").trim() || "—",
        status: String(b.status ?? ""),
        staffId: b.staff_id,
        resourceId: b.resource_id,
        prepMinutes: b.prep_minutes,
        serviceStartsAt: b.service_start_time_utc,
        serviceEndsAt: b.service_end_time_utc,
        occupiedStartsAt: b.start_time_utc,
        occupiedEndsAt: b.end_time_utc,
        groupId: b.group_id,
      }];
    }).sort((a, b) => Date.parse(a.occupiedStartsAt) - Date.parse(b.occupiedStartsAt));

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
            reservationId: b.reservation_id,
            clientName: String(b.client_name ?? "").trim() || "—",
            endsAt: new Date(endMs).toISOString(),
            scheduleModel: b.schedule_model,
            segmentId: b.segment_id,
            staffId: b.staff_id!,
            resourceId: b.resource_id,
            prepMinutes: b.prep_minutes,
            serviceStartsAt: b.service_start_time_utc!,
            serviceEndsAt: b.service_end_time_utc!,
            occupiedStartsAt: b.start_time_utc!,
            occupiedEndsAt: b.end_time_utc!,
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
            reservationId: b.reservation_id,
            clientName: String(b.client_name ?? "").trim() || "—",
            endsAt: new Date(projected).toISOString(),
            scheduleModel: b.schedule_model,
            segmentId: b.segment_id,
            staffId: b.staff_id!,
            resourceId: b.resource_id,
            prepMinutes: b.prep_minutes,
            serviceStartsAt: b.service_start_time_utc!,
            serviceEndsAt: b.service_end_time_utc!,
            occupiedStartsAt: b.start_time_utc!,
            occupiedEndsAt: b.end_time_utc!,
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
      reservations,
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
