"use server";

import * as Sentry from "@sentry/nextjs";

/**
 * AI Arrival-First scheduler for the group booking flow.
 *
 * Inputs the customer's *arrival preference* (morning / afternoon /
 * evening / specific time) plus per-member service + optional
 * preferred staff. Returns up to three "arrangement" options ranked
 * by closeness of arrival times:
 *
 *   1. BEST         — everyone starts within 15 min, preferred
 *                     staff respected where requested.
 *   2. ALTERNATIVE  — everyone starts within 30 min; preferred
 *                     staff still respected. May reuse some staff
 *                     at non-overlapping times.
 *   3. EARLIEST     — first valid arrangement in the search window
 *                     regardless of grouping or preferred-staff. Used
 *                     as the "just get me in" fallback.
 *
 * Reuses (NEVER reimplements):
 *   - `salonTime.ts` (`salonWallTimeToUtcIso`, `salonDayRangeUtc`)
 *     for DST-safe timezone conversion. The scheduler operates in
 *     UTC ms internally; salon-local wall-time is only used at the
 *     I/O boundary (arrival window + opening hours).
 *   - `staffCapability.ts` (`buildCapabilityMap`,
 *     `filterStaffCapableForService`) — same capability rows that
 *     gate the individual flow.
 *   - `bookingIntervals.ts` (`intervalsOverlapMs`) — exact same
 *     overlap predicate used by `submitGroupBooking` and the GIST
 *     constraint.
 *   - `parseBookingClosedDates.ts` (`parseBookingClosedDateSet`)
 *     for closed-day detection. Owner-toggled closures here take
 *     precedence over opening-hours.
 *   - `openingHoursDefaults.ts` (`parseOpeningHours`) for HH:MM
 *     open/close per weekday.
 *
 * Scope:
 *   - Public booking only. Server action, callable from the client.
 *   - Read-only — never writes bookings. The customer still confirms
 *     via `submitGroupBooking` once they pick an arrangement.
 *   - 15-minute slot granularity (matches the individual flow's
 *     time-slot grid).
 */

import { createClient } from "@/shared/lib/supabase/server";
import {
  intervalsOverlapMs,
} from "@/shared/booking/bookingIntervals";
import { parseBookingClosedDateSet } from "@/shared/booking/parseBookingClosedDates";
import {
  buildCapabilityMap,
  isStaffCapableForService,
  type StaffCapabilityMap,
} from "@/shared/booking/staffCapability";
import {
  parseOpeningHours,
  type DayKey,
  type OpeningHoursWeek,
} from "@/shared/dashboard/openingHoursDefaults";
import {
  formatInSalonTz,
  salonDayRangeUtc,
  salonWallTimeToUtcIso,
} from "@/shared/lib/salonTime";

/** Arrival window pill or a specific HH:MM (24h) target. */
export type GroupArrivalPreference =
  | { kind: "morning" }
  | { kind: "afternoon" }
  | { kind: "evening" }
  | { kind: "specific"; time: string };

export type GroupSmartScheduleMemberInput = {
  /** Display name only — passes straight through; not used by the
   *  algorithm beyond echoing back in the arrangement so the UI can
   *  render "Mai · 9:00 · Linda". */
  name: string;
  serviceId: string;
  /** Customer's preferred staff. `null` = "Any" (load-balanced). */
  preferredStaffId: string | null;
};

export type GroupSmartScheduleParams = {
  shopSlug: string;
  /** YYYY-MM-DD in salon-local time. */
  date: string;
  arrivalPref: GroupArrivalPreference;
  members: GroupSmartScheduleMemberInput[];
};

export type GroupArrangementAssignment = {
  /** 0-indexed position from the input `members[]`. */
  memberIndex: number;
  staffId: string;
  staffName: string;
  /** UTC ISO start of this member's appointment. */
  startUtcIso: string;
  /** UTC ISO end (inclusive of buffer). */
  endUtcIso: string;
  /** Salon-local wall-time "9:30 AM" for the BEST/EARLIEST card. */
  startDisplay: string;
  endDisplay: string;
  /** Total minutes including buffer. */
  durationMinutes: number;
  priceCents: number | null;
  /** Echoed for UI rendering — same value as input.name. */
  memberName: string;
  serviceName: string;
};

export type GroupArrangement = {
  kind: "best" | "alternative" | "earliest";
  /** Earliest start across the arrangement (UTC ms). */
  groupStartMs: number;
  /** Latest end across the arrangement (UTC ms). */
  groupEndMs: number;
  groupStartDisplay: string;
  groupEndDisplay: string;
  /** Total spread in minutes between earliest and latest start. */
  spreadMinutes: number;
  /** Sum of priceCents across members. `null` if any service is
   *  unpriced (mixed-price catalog). */
  totalCents: number | null;
  assignments: GroupArrangementAssignment[];
};

export type GroupSmartScheduleResult =
  | {
      ok: true;
      arrangements: GroupArrangement[];
      /** Salon-tz timezone string the times above are rendered in. */
      timezone: string;
    }
  | {
      ok: false;
      reason:
        | "salon_closed"
        | "no_slots"
        | "salon_not_found"
        | "salon_paused"
        | "invalid_input"
        | "server_error"
        // Task #04-B — defensive guard. After migration
        // 20260512600000 the salons.timezone column is NOT NULL,
        // so this branch is only reachable if (a) the migration
        // is somehow reverted, or (b) the column was wiped between
        // resolve and read. Surfacing as a distinct reason lets
        // the UI render a "contact the salon" message instead of
        // silently falling back to UTC and computing wrong slots.
        | "timezone_not_set";
    };

/** Salon-local weekday key for a YMD; UTC arithmetic (the YMD is
 *  already salon-local). */
const DAY_KEY_BY_INDEX: readonly DayKey[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];
function dayKeyForYmd(ymd: string): DayKey | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const idx = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
  ).getUTCDay();
  return DAY_KEY_BY_INDEX[idx] ?? null;
}

function hmToMinutes(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

const SLOT_STEP_MIN = 15;
const BEST_SPREAD_LIMIT_MIN = 15;
const ALT_SPREAD_LIMIT_MIN = 30;

/** Map an arrival pill onto a [minStart, maxStart] window in
 *  minutes-from-midnight, then clamp against opening hours. The
 *  upper bound is the latest *start* time we'll consider — the
 *  member's end can fall past it as long as it's still inside
 *  salon hours. */
function windowForArrival(
  pref: GroupArrivalPreference,
  dayHours: { open: string; close: string; closed: boolean } | null,
): { startMin: number; endMin: number } | null {
  if (!dayHours || dayHours.closed) return null;
  const openMin = hmToMinutes(dayHours.open);
  const closeMin = hmToMinutes(dayHours.close);
  if (openMin === null || closeMin === null || closeMin <= openMin) return null;

  let lo = openMin;
  let hi = closeMin;
  if (pref.kind === "morning") {
    lo = Math.max(openMin, 9 * 60);
    hi = Math.min(closeMin, 12 * 60);
  } else if (pref.kind === "afternoon") {
    lo = Math.max(openMin, 12 * 60);
    hi = Math.min(closeMin, 17 * 60);
  } else if (pref.kind === "evening") {
    lo = Math.max(openMin, 17 * 60);
    hi = closeMin;
  } else if (pref.kind === "specific") {
    const t = hmToMinutes(pref.time);
    if (t === null) return null;
    lo = Math.max(openMin, t - 90);
    hi = Math.min(closeMin, t + 90);
  }
  if (hi <= lo) return null;
  return { startMin: lo, endMin: hi };
}

type ResolvedMember = {
  /** Input index. */
  index: number;
  name: string;
  serviceId: string;
  serviceName: string;
  /** Total minutes (duration + buffer) for occupancy math. */
  totalMinutes: number;
  priceCents: number | null;
  preferredStaffId: string | null;
};

type StaffRow = { id: string; name: string };
type ExistingBooking = {
  staffId: string;
  startMs: number;
  endMs: number;
};

/**
 * Check whether `staffId` is free for `[startMs, endMs)` against
 * existing bookings + an in-arrangement "soft" reservations map.
 */
function staffIsFree(
  staffId: string,
  startMs: number,
  endMs: number,
  existing: ExistingBooking[],
  softReservations: Map<string, Array<{ startMs: number; endMs: number }>>,
): boolean {
  for (const b of existing) {
    if (b.staffId !== staffId) continue;
    if (intervalsOverlapMs(startMs, endMs, b.startMs, b.endMs)) return false;
  }
  const soft = softReservations.get(staffId);
  if (soft) {
    for (const s of soft) {
      if (intervalsOverlapMs(startMs, endMs, s.startMs, s.endMs)) return false;
    }
  }
  return true;
}

/**
 * Assign each member to a staff at the given anchor (all members
 * start at `anchorMs`). Returns the assignments or `null` if the
 * combination is infeasible. `respectPreferred` controls whether a
 * member with a non-null `preferredStaffId` may fall back to any
 * other capable staff.
 */
function tryAlignedArrangement(
  anchorMs: number,
  members: ResolvedMember[],
  staff: readonly StaffRow[],
  staffById: Map<string, StaffRow>,
  capability: StaffCapabilityMap,
  existing: ExistingBooking[],
  respectPreferred: boolean,
): { assignments: Array<{ memberIdx: number; staffId: string; startMs: number; endMs: number }> } | null {
  // Members with explicit preferred staff go first — they're the
  // hard constraint. Members with "any" pick second so they can
  // fill whichever staff are left.
  const order = members
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ap = a.m.preferredStaffId != null ? 0 : 1;
      const bp = b.m.preferredStaffId != null ? 0 : 1;
      return ap - bp;
    });

  const soft = new Map<string, Array<{ startMs: number; endMs: number }>>();
  const out: Array<{ memberIdx: number; staffId: string; startMs: number; endMs: number }> = [];

  for (const entry of order) {
    const m = entry.m;
    const startMs = anchorMs;
    const endMs = anchorMs + m.totalMinutes * 60_000;

    const candidateOrder: string[] = [];
    if (m.preferredStaffId != null) {
      candidateOrder.push(m.preferredStaffId);
      if (!respectPreferred) {
        for (const s of staff) {
          if (s.id !== m.preferredStaffId) candidateOrder.push(s.id);
        }
      }
    } else {
      for (const s of staff) candidateOrder.push(s.id);
    }

    let pickedStaff: string | null = null;
    for (const sid of candidateOrder) {
      const row = staffById.get(sid);
      if (!row) continue;
      if (!isStaffCapableForService(capability, sid, m.serviceId)) continue;
      if (!staffIsFree(sid, startMs, endMs, existing, soft)) continue;
      pickedStaff = sid;
      break;
    }

    if (pickedStaff === null) return null;
    const bucket = soft.get(pickedStaff) ?? [];
    bucket.push({ startMs, endMs });
    soft.set(pickedStaff, bucket);
    out.push({ memberIdx: m.index, staffId: pickedStaff, startMs, endMs });
  }

  // Re-sort to the original member order so callers can index by
  // memberIndex naturally.
  out.sort((a, b) => a.memberIdx - b.memberIdx);
  return { assignments: out };
}

/**
 * Stagger search: try assigning each member at the anchor first,
 * then if anyone can't fit, try shifting that member +15/+30 min
 * (still within ALT_SPREAD_LIMIT_MIN of the earliest start). This
 * powers the ALTERNATIVE option. Greedy + bounded — not exhaustive,
 * but the 30-min window keeps the branching small.
 */
function tryStaggeredArrangement(
  anchorMs: number,
  members: ResolvedMember[],
  staff: readonly StaffRow[],
  staffById: Map<string, StaffRow>,
  capability: StaffCapabilityMap,
  existing: ExistingBooking[],
  spreadCapMin: number,
): { assignments: Array<{ memberIdx: number; staffId: string; startMs: number; endMs: number }> } | null {
  const order = members
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ap = a.m.preferredStaffId != null ? 0 : 1;
      const bp = b.m.preferredStaffId != null ? 0 : 1;
      return ap - bp;
    });

  const offsets: number[] = [];
  for (let off = 0; off <= spreadCapMin; off += SLOT_STEP_MIN) offsets.push(off);

  const soft = new Map<string, Array<{ startMs: number; endMs: number }>>();
  const out: Array<{ memberIdx: number; staffId: string; startMs: number; endMs: number }> = [];

  for (const entry of order) {
    const m = entry.m;
    let placed: { staffId: string; startMs: number; endMs: number } | null = null;

    for (const off of offsets) {
      const startMs = anchorMs + off * 60_000;
      const endMs = startMs + m.totalMinutes * 60_000;
      const candidateOrder: string[] = [];
      if (m.preferredStaffId != null) {
        candidateOrder.push(m.preferredStaffId);
      } else {
        for (const s of staff) candidateOrder.push(s.id);
      }
      for (const sid of candidateOrder) {
        if (!isStaffCapableForService(capability, sid, m.serviceId)) continue;
        if (!staffIsFree(sid, startMs, endMs, existing, soft)) continue;
        placed = { staffId: sid, startMs, endMs };
        break;
      }
      if (placed) break;
    }

    if (!placed) return null;
    const bucket = soft.get(placed.staffId) ?? [];
    bucket.push({ startMs: placed.startMs, endMs: placed.endMs });
    soft.set(placed.staffId, bucket);
    out.push({
      memberIdx: m.index,
      staffId: placed.staffId,
      startMs: placed.startMs,
      endMs: placed.endMs,
    });
  }

  out.sort((a, b) => a.memberIdx - b.memberIdx);
  return { assignments: out };
}

function buildArrangement(
  kind: GroupArrangement["kind"],
  raw: { assignments: Array<{ memberIdx: number; staffId: string; startMs: number; endMs: number }> },
  members: ResolvedMember[],
  staffById: Map<string, StaffRow>,
  timezone: string,
): GroupArrangement {
  let groupStartMs = Number.POSITIVE_INFINITY;
  let groupEndMs = Number.NEGATIVE_INFINITY;
  const assignments: GroupArrangementAssignment[] = raw.assignments.map((a) => {
    const m = members[a.memberIdx];
    const staff = staffById.get(a.staffId);
    const startIso = new Date(a.startMs).toISOString();
    const endIso = new Date(a.endMs).toISOString();
    if (a.startMs < groupStartMs) groupStartMs = a.startMs;
    if (a.endMs > groupEndMs) groupEndMs = a.endMs;
    return {
      memberIndex: a.memberIdx,
      staffId: a.staffId,
      staffName: staff?.name ?? "",
      startUtcIso: startIso,
      endUtcIso: endIso,
      startDisplay: formatInSalonTz(startIso, timezone, "shortTime"),
      endDisplay: formatInSalonTz(endIso, timezone, "shortTime"),
      durationMinutes: m.totalMinutes,
      priceCents: m.priceCents,
      memberName: m.name,
      serviceName: m.serviceName,
    };
  });

  // Span: latest start - earliest start.
  let minStart = Number.POSITIVE_INFINITY;
  let maxStart = Number.NEGATIVE_INFINITY;
  for (const a of raw.assignments) {
    if (a.startMs < minStart) minStart = a.startMs;
    if (a.startMs > maxStart) maxStart = a.startMs;
  }
  const spreadMinutes = Math.round((maxStart - minStart) / 60_000);

  // Total cents — null if ANY member has unpriced service so we
  // don't lie about partial sums.
  let totalCents: number | null = 0;
  for (const m of members) {
    if (m.priceCents == null) {
      totalCents = null;
      break;
    }
    totalCents = (totalCents ?? 0) + m.priceCents;
  }

  const groupStartIso = new Date(groupStartMs).toISOString();
  const groupEndIso = new Date(groupEndMs).toISOString();
  return {
    kind,
    groupStartMs,
    groupEndMs,
    groupStartDisplay: formatInSalonTz(groupStartIso, timezone, "shortTime"),
    groupEndDisplay: formatInSalonTz(groupEndIso, timezone, "shortTime"),
    spreadMinutes,
    totalCents,
    assignments,
  };
}

export async function loadGroupSmartSchedule(
  params: GroupSmartScheduleParams,
): Promise<GroupSmartScheduleResult> {
  if (!Array.isArray(params.members) || params.members.length < 2) {
    return { ok: false, reason: "invalid_input" };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.date)) {
    return { ok: false, reason: "invalid_input" };
  }

  const supabase = await createClient();

  // 1. Salon ---------------------------------------------------------
  const { data: salonRaw, error: salonErr } = await supabase
    .from("salons")
    .select("id, profile_complete, opening_hours, timezone, booking_closed_dates")
    .eq("slug", params.shopSlug)
    .maybeSingle();
  if (salonErr || !salonRaw) return { ok: false, reason: "salon_not_found" };
  const salonRow = salonRaw as unknown as {
    id: string;
    profile_complete?: unknown;
    opening_hours?: unknown;
    timezone?: unknown;
    booking_closed_dates?: unknown;
  };
  if (!salonRow.profile_complete) return { ok: false, reason: "salon_paused" };

  // Task #04-B — strict timezone read. Previously fell back to "UTC"
  // which produced an 8-hour offset bug for Vancouver tenants when
  // the column happened to be empty. Migration 20260512600000 makes
  // this unreachable in normal flow; the guard stays as defense in
  // depth so a corrupt row can never produce wrong slot math.
  const rawTimezone =
    typeof salonRow.timezone === "string" ? salonRow.timezone.trim() : "";
  if (rawTimezone.length === 0) {
    return { ok: false, reason: "timezone_not_set" };
  }
  const timezone = rawTimezone;

  // 2. Closed-day guard (owner override beats opening_hours) --------
  const closedYmdSet = parseBookingClosedDateSet(salonRow.booking_closed_dates);
  if (closedYmdSet.has(params.date)) {
    return { ok: false, reason: "salon_closed" };
  }

  // 3. Opening hours for this weekday --------------------------------
  const openingWeek: OpeningHoursWeek | null = parseOpeningHours(
    salonRow.opening_hours,
  );
  const dayKey = dayKeyForYmd(params.date);
  const dayHours = openingWeek && dayKey ? openingWeek[dayKey] : null;
  if (!dayHours || dayHours.closed) {
    return { ok: false, reason: "salon_closed" };
  }

  // 4. Resolve arrival window ----------------------------------------
  const window = windowForArrival(params.arrivalPref, dayHours);
  if (!window) return { ok: false, reason: "no_slots" };

  // 5. Services ------------------------------------------------------
  const serviceIds = Array.from(
    new Set(params.members.map((m) => m.serviceId).filter((id) => !!id)),
  );
  if (serviceIds.length === 0) return { ok: false, reason: "invalid_input" };
  const { data: serviceRows, error: svcErr } = await supabase
    .from("services")
    .select("id, name, duration_minutes, buffer_minutes, price_cents")
    .in("id", serviceIds)
    .eq("salon_id", salonRow.id)
    .is("deleted_at" as never, null);
  if (svcErr) return { ok: false, reason: "server_error" };
  const serviceById = new Map<
    string,
    { id: string; name: string; totalMin: number; priceCents: number | null }
  >();
  for (const r of serviceRows ?? []) {
    const dur = Number(r.duration_minutes) || 0;
    const buf = Number(r.buffer_minutes) || 0;
    // Task #04-D FIX 17 — surface zero-buffer services so the
    // operator can fix the catalog. A 0-min buffer back-to-backs
    // the next booking right on top of the previous one's
    // wall-clock end, which produces a poor in-salon experience
    // (no cleanup/setup time). We don't block — some salons
    // legitimately run 0-buffer for express services — but the
    // rate of capture lets ops nudge tenants that look misconfigured.
    if (buf === 0) {
      Sentry.captureMessage("service_zero_buffer", {
        level: "warning",
        tags: {
          surface: "group_smart_schedule",
        },
        extra: {
          serviceId: String(r.id),
          serviceName: String(r.name ?? ""),
          salonId: salonRow.id,
          slug: params.shopSlug,
        },
      });
    }
    serviceById.set(String(r.id), {
      id: String(r.id),
      name: String(r.name ?? ""),
      totalMin: dur + buf,
      priceCents: r.price_cents != null ? Number(r.price_cents) : null,
    });
  }
  // Each member must reference an existing service.
  const resolvedMembers: ResolvedMember[] = [];
  for (let i = 0; i < params.members.length; i++) {
    const m = params.members[i];
    const svc = serviceById.get(m.serviceId);
    if (!svc) return { ok: false, reason: "invalid_input" };
    resolvedMembers.push({
      index: i,
      name: m.name,
      serviceId: m.serviceId,
      serviceName: svc.name,
      totalMinutes: svc.totalMin,
      priceCents: svc.priceCents,
      preferredStaffId: m.preferredStaffId ?? null,
    });
  }

  // 6. Staff ---------------------------------------------------------
  const { data: staffRows, error: staffErr } = await supabase
    .from("staff")
    .select("id, name")
    .eq("salon_id", salonRow.id)
    .eq("status", "active")
    .is("deleted_at" as never, null);
  if (staffErr) return { ok: false, reason: "server_error" };
  const staffList: StaffRow[] = (staffRows ?? []).map((s) => ({
    id: String(s.id),
    name: String(s.name ?? ""),
  }));
  if (staffList.length < resolvedMembers.length) {
    // Not enough physical staff to host this group on any day.
    return { ok: false, reason: "no_slots" };
  }
  const staffById = new Map<string, StaffRow>();
  for (const s of staffList) staffById.set(s.id, s);

  // 7. Staff capability ---------------------------------------------
  let capabilityRows: { staff_id: string; service_id: string }[] = [];
  const { data: capRows } = await supabase
    .from("staff_services")
    .select("staff_id, service_id")
    .in("staff_id", staffList.map((s) => s.id));
  if (capRows && capRows.length > 0) {
    capabilityRows = (capRows ?? []).map((r) => ({
      staff_id: String(r.staff_id),
      service_id: String(r.service_id),
    }));
  }
  const capability: StaffCapabilityMap =
    capabilityRows.length > 0 ? buildCapabilityMap(capabilityRows) : null;

  // 8. Existing bookings for the date -------------------------------
  const { startUtc, endUtc } = salonDayRangeUtc(params.date, timezone);
  const { data: occRows, error: occErr } = await supabase.rpc(
    "public_booking_occupancy_for_range",
    { p_salon_id: salonRow.id, p_start: startUtc, p_end: endUtc },
  );
  if (occErr) return { ok: false, reason: "server_error" };
  const existing: ExistingBooking[] = ((occRows ?? []) as Array<{
    staff_id: string;
    start_time_utc: string;
    end_time_utc: string;
  }>).flatMap((row) => {
    if (!row.staff_id) return [];
    const startMs = Date.parse(row.start_time_utc);
    const endMs = Date.parse(row.end_time_utc);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
    return [{ staffId: String(row.staff_id), startMs, endMs }];
  });

  // 9. Validate preferred-staff references --------------------------
  // A member can reference a preferred staff that doesn't actually
  // exist or isn't capable for their service. Drop the preference
  // silently in that case so the scheduler still has a chance.
  for (const m of resolvedMembers) {
    if (m.preferredStaffId === null) continue;
    if (!staffById.has(m.preferredStaffId)) m.preferredStaffId = null;
    else if (!isStaffCapableForService(capability, m.preferredStaffId, m.serviceId))
      m.preferredStaffId = null;
  }

  // 10. Slot scan ----------------------------------------------------
  const anchors: number[] = [];
  for (let mm = window.startMin; mm <= window.endMin; mm += SLOT_STEP_MIN) {
    const iso = salonWallTimeToUtcIso(params.date, mm, timezone);
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) anchors.push(ms);
  }
  if (anchors.length === 0) return { ok: false, reason: "no_slots" };

  let bestArrangement: GroupArrangement | null = null;
  let altArrangement: GroupArrangement | null = null;
  let earliestArrangement: GroupArrangement | null = null;

  for (const anchorMs of anchors) {
    // BEST attempt — fully aligned (spread=0), preferred staff respected.
    if (!bestArrangement) {
      const aligned = tryAlignedArrangement(
        anchorMs,
        resolvedMembers,
        staffList,
        staffById,
        capability,
        existing,
        true,
      );
      if (aligned) {
        bestArrangement = buildArrangement(
          "best",
          aligned,
          resolvedMembers,
          staffById,
          timezone,
        );
      }
    }

    // ALTERNATIVE attempt — staggered up to 30 min.
    if (!altArrangement) {
      const staggered = tryStaggeredArrangement(
        anchorMs,
        resolvedMembers,
        staffList,
        staffById,
        capability,
        existing,
        ALT_SPREAD_LIMIT_MIN,
      );
      if (staggered) {
        // Skip if this is identical to BEST (anchor + aligned) so we
        // don't return the same arrangement twice.
        const sameAsBest =
          bestArrangement !== null &&
          bestArrangement.assignments.every((a, i) =>
            staggered.assignments[i] &&
            staggered.assignments[i].staffId === a.staffId &&
            staggered.assignments[i].startMs ===
              Date.parse(a.startUtcIso),
          );
        if (!sameAsBest) {
          altArrangement = buildArrangement(
            "alternative",
            staggered,
            resolvedMembers,
            staffById,
            timezone,
          );
        }
      }
    }

    // EARLIEST attempt — preferred-staff *not* required, anchor-aligned.
    if (!earliestArrangement) {
      const earliest = tryAlignedArrangement(
        anchorMs,
        resolvedMembers,
        staffList,
        staffById,
        capability,
        existing,
        false,
      );
      if (earliest) {
        earliestArrangement = buildArrangement(
          "earliest",
          earliest,
          resolvedMembers,
          staffById,
          timezone,
        );
      }
    }

    if (bestArrangement && altArrangement && earliestArrangement) break;
  }

  // Final spread filtering:
  //   - BEST must be ≤ 15min spread (always true for aligned).
  //   - ALT must be ≤ 30min spread and not == BEST.
  //   - EARLIEST is "any valid"; dedupe vs BEST.
  const arrangements: GroupArrangement[] = [];
  if (bestArrangement && bestArrangement.spreadMinutes <= BEST_SPREAD_LIMIT_MIN) {
    arrangements.push(bestArrangement);
  }
  if (
    altArrangement &&
    altArrangement.spreadMinutes <= ALT_SPREAD_LIMIT_MIN &&
    (!bestArrangement || altArrangement.groupStartMs !== bestArrangement.groupStartMs)
  ) {
    arrangements.push(altArrangement);
  }
  if (
    earliestArrangement &&
    (!bestArrangement ||
      earliestArrangement.groupStartMs !== bestArrangement.groupStartMs ||
      // Different staff assignments still count as a distinct option.
      earliestArrangement.assignments.some(
        (a, i) =>
          bestArrangement!.assignments[i] &&
          a.staffId !== bestArrangement!.assignments[i].staffId,
      ))
  ) {
    arrangements.push(earliestArrangement);
  }

  if (arrangements.length === 0) {
    return { ok: false, reason: "no_slots" };
  }

  return { ok: true, arrangements, timezone };
}
