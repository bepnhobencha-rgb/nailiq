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

import type { SupabaseClient } from "@supabase/supabase-js";

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
  ALTERNATIVE_QUERY_TIMEOUT_MS,
  ALTERNATIVE_SEARCH_DAYS,
  SPLIT_LATE_BUFFER_MIN,
} from "@/shared/config/constants";
import {
  parseOpeningHours,
  type DayKey,
  type OpeningHoursWeek,
} from "@/shared/dashboard/openingHoursDefaults";
import {
  formatInSalonTz,
  salonDateOffset,
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

/** Scheduling synchronisation preference for group bookings.
 *  "sync_start": all members arrive and start at the same anchor time
 *               (the original and still-default behaviour).
 *  "sync_finish": all members finish at the same target time; each
 *                 member's start is computed as
 *                 targetFinishMs − service.totalMinutes × 60_000.
 *                 Longer services therefore start earlier. */
export type GroupSyncMode = "sync_start" | "sync_finish";

export type GroupSmartScheduleParams = {
  shopSlug: string;
  /** YYYY-MM-DD in salon-local time. */
  date: string;
  arrivalPref: GroupArrivalPreference;
  members: GroupSmartScheduleMemberInput[];
  /** "sync_start" (default) = arrive together; "sync_finish" = finish
   *  together.  Backward-compatible: omitting defaults to sync_start.  */
  mode?: GroupSyncMode;
  /** Required when mode === "sync_finish".  Salon-local HH:MM (24h) of
   *  the desired finish time.  arrivalPref is ignored in this mode. */
  finishTime?: string;
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

/**
 * Task #05 — when the full group can't fit on the requested date
 * the scheduler attempts three sub-queries in parallel and
 * surfaces whichever succeed inside the 5 s budget. The UI
 * renders one card per non-null entry; if all three are null the
 * empty state falls back to "no alternatives — please try
 * another date".
 *
 * Each alternative carries enough data for the UI to either
 * (a) navigate the user to a different point in the flow with
 * fields pre-filled, or (b) submit a split booking directly via
 * the existing per-member `time` payload on `submitGroupBooking`.
 */
export type GroupAlternatives = {
  /**
   * N-1 members fit at `mainTime`, the remaining 1 (always the
   * last member by input index — matches the spec) fits at
   * `lateTime` after the main group's wall-clock end + the
   * `SPLIT_LATE_BUFFER_MIN` buffer. UI shows it as "4 people at
   * 2:00 PM, Emma at 3:30 PM with Tina".
   */
  splitOption: {
    mainArrangement: GroupArrangement;
    /** Wall-time HH:MM string (salon tz) for the main group. */
    mainTime: string;
    mainSize: number;
    /** Wall-time HH:MM string for the late member. */
    lateTime: string;
    lateStaffId: string;
    lateStaffName: string;
    lateMemberIndex: number;
    /** Display name of the late member (echoed from input). */
    lateMemberName: string;
    /** Pre-built assignment list ready to flow into step 5 —
     *  matches the shape of `GroupArrangement.assignments`. The
     *  late member's `startUtcIso` is its split time, all others
     *  are the main time. */
    assignments: GroupArrangementAssignment[];
  } | null;
  /**
   * First salon-local day in the next `ALTERNATIVE_SEARCH_DAYS`
   * window where the full group fits at the original arrival
   * preference. `null` when none of the candidate days returned
   * inside the timeout / all of them were also no-slot.
   */
  nextAvailableDate: {
    /** YYYY-MM-DD in salon tz. */
    date: string;
    /** Earliest arrangement on that day — what the UI shows as
     *  "{label} — N people at {time}". */
    arrangement: GroupArrangement;
    /** Wall-time HH:MM string for the earliest member start. */
    time: string;
  } | null;
  /**
   * Same-day cross-window flip. If the user picked afternoon /
   * evening / specific we try morning; if they picked morning we
   * try afternoon. `null` for specific-time queries (the user
   * already targeted an exact slot, so "earlier" is ambiguous)
   * and when the alternate window has no arrangements either.
   */
  earlierToday: {
    arrangement: GroupArrangement;
    /** Wall-time HH:MM string for the earliest member start. */
    time: string;
  } | null;
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
      reason: "no_slots";
      /** Salon-tz timezone string — present even on `no_slots` so
       *  the UI can format alternative timestamps. */
      timezone: string;
      /** Task #05 — null-safe slots; UI renders one card per
       *  non-null member. All three can be null on a truly empty
       *  salon (closed + no future bookable days). */
      alternatives: GroupAlternatives;
    }
  | {
      ok: false;
      reason:
        | "salon_closed"
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

/**
 * Sync-finish assignment: ALL members end at exactly `targetFinishMs`.
 * Member i starts at `targetFinishMs − member_i.totalMinutes × 60_000`.
 * Longer services start earlier — they are processed first so the
 * hardest-to-fill (earliest-start) slots are locked before shorter ones.
 * Returns null if any member's start would fall before `dayOpenMs` or
 * no capable, free staff can be found.
 */
function tryFinishAlignedArrangement(
  targetFinishMs: number,
  dayOpenMs: number,
  members: ResolvedMember[],
  staff: readonly StaffRow[],
  staffById: Map<string, StaffRow>,
  capability: StaffCapabilityMap,
  existing: ExistingBooking[],
  respectPreferred: boolean,
): { assignments: Array<{ memberIdx: number; staffId: string; startMs: number; endMs: number }> } | null {
  // Compute per-member start times and validate against dayOpen.
  const slots = members.map((m) => ({
    m,
    startMs: targetFinishMs - m.totalMinutes * 60_000,
    endMs: targetFinishMs,
  }));
  for (const s of slots) {
    if (s.startMs < dayOpenMs) return null;
  }

  // Sort: preferred-staff members first (hard constraint), then by earliest
  // start (= longest service) so we fill the tightest slots first.
  const order = slots
    .map((s) => s)
    .sort((a, b) => {
      const ap = a.m.preferredStaffId != null ? 0 : 1;
      const bp = b.m.preferredStaffId != null ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.startMs - b.startMs; // earliest start first
    });

  const soft = new Map<string, Array<{ startMs: number; endMs: number }>>();
  const out: Array<{ memberIdx: number; staffId: string; startMs: number; endMs: number }> = [];

  for (const slot of order) {
    const { m, startMs, endMs } = slot;
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

/**
 * Internal flag — when true, skips the smart-alternatives
 * computation on `no_slots`. Set by `computeNextAvailableDate`
 * when it fans out to candidate days so we don't loop forever:
 *   loadGroupSmartSchedule (date A, no slots)
 *     → computeAlternatives
 *       → computeNextAvailableDate (date B)
 *         → loadGroupSmartSchedule (date B, no slots, no further alts)
 */
type InternalScheduleOpts = { skipAlternatives?: boolean };

export async function loadGroupSmartSchedule(
  params: GroupSmartScheduleParams,
  _opts: InternalScheduleOpts = {},
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

  // 4. Resolve arrival window (sync_start only) ---------------------
  const isSyncFinish = params.mode === "sync_finish";
  const window = isSyncFinish
    ? null
    : windowForArrival(params.arrivalPref, dayHours);
  if (!isSyncFinish && !window) {
    // Specific-time outside opening hours / morning window after
    // close — empty alternatives because we haven't loaded staff
    // or bookings yet and can't responsibly suggest a split or
    // earlier-today flip without that context.
    return {
      ok: false,
      reason: "no_slots",
      timezone,
      alternatives: {
        splitOption: null,
        nextAvailableDate: null,
        earlierToday: null,
      },
    };
  }

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
    // Not enough physical staff to host this group on ANY day —
    // staff roster is the same across dates, so next-date is
    // hopeless. Same logic excludes split (split needs even more
    // staff capacity) and earlier-today (window is irrelevant
    // when no day can host the group).
    return {
      ok: false,
      reason: "no_slots",
      timezone,
      alternatives: {
        splitOption: null,
        nextAvailableDate: null,
        earlierToday: null,
      },
    };
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
  // Branch on sync mode: sync_finish uses a different search engine
  // that anchors on the finish time rather than the start time.
  // Task #05 — pure-search functions are extracted so the alternatives
  // sub-queries can reuse the loaded staff / capability / existing-
  // bookings ctx without re-fetching from the DB.
  let arrangements: GroupArrangement[];

  if (isSyncFinish) {
    // ── sync_finish path ─────────────────────────────────────────
    // Parse the customer's desired finish time and convert to UTC ms.
    const finishMinutes = hmToMinutes(params.finishTime ?? "");
    if (finishMinutes === null) {
      // No finish time or invalid format — surface as no_slots so
      // the UI can show the "Try another time" back-out CTA.
      return {
        ok: false,
        reason: "no_slots",
        timezone,
        alternatives: { splitOption: null, nextAvailableDate: null, earlierToday: null },
      };
    }
    const openMin = hmToMinutes(dayHours.open) ?? 0;
    const closeMin = hmToMinutes(dayHours.close) ?? 0;
    const dayOpenMs = Date.parse(
      salonWallTimeToUtcIso(params.date, openMin, timezone),
    );
    const targetFinishMs = Date.parse(
      salonWallTimeToUtcIso(params.date, finishMinutes, timezone),
    );
    const dayCloseMs = Date.parse(
      salonWallTimeToUtcIso(params.date, closeMin, timezone),
    );
    arrangements = findFinishArrangementsInWindow({
      targetFinishMs,
      dayOpenMs,
      dayCloseMs,
      date: params.date,
      timezone,
      resolvedMembers,
      staffList,
      staffById,
      capability,
      existing,
    });
  } else {
    // ── sync_start path (original) ───────────────────────────────
    arrangements = findArrangementsInWindow({
      date: params.date,
      timezone,
      window: window!,
      closeMin: hmToMinutes(dayHours.close) ?? 0,
      resolvedMembers,
      staffList,
      staffById,
      capability,
      existing,
    });
  }

  if (arrangements.length === 0) {
    // Task #05 — instead of dead-ending the user, compute up to
    // three alternative paths in parallel: split (N-1 now + 1
    // later same day), next-available-date (next 5 salon-local
    // days), earlier-today (cross-window flip). Each races a 5 s
    // budget — whichever return inside the budget are surfaced.
    //
    // Phase 1: alternatives are only computed for sync_start; in
    // sync_finish mode the user should adjust their finish time or
    // switch mode. The recursion guard also skips alternatives when
    // we ARE the next-date sub-query (prevents exponential fan-out).
    const skipAlts = _opts.skipAlternatives || isSyncFinish;
    const alternatives = skipAlts
      ? { splitOption: null, nextAvailableDate: null, earlierToday: null }
      : await computeAlternatives({
          supabase,
          shopSlug: params.shopSlug,
          salonId: salonRow.id,
          date: params.date,
          timezone,
          arrivalPref: params.arrivalPref,
          dayHours,
          window: window!,
          resolvedMembers,
          staffList,
          staffById,
          capability,
          existing,
          rawMembers: params.members,
          mode: params.mode,
          finishTime: params.finishTime,
        });
    return { ok: false, reason: "no_slots", timezone, alternatives };
  }

  return { ok: true, arrangements, timezone };
}

// ─── Pure search ────────────────────────────────────────────────
// Task #05 — extracted from the old inline block in
// `loadGroupSmartSchedule`. Takes everything the search needs as
// pre-loaded data so the alternatives path can call it multiple
// times (different windows, different member subsets) without
// hitting the DB again.

type SchedulerSearchCtx = {
  date: string;
  timezone: string;
  window: { startMin: number; endMin: number };
  /** Salon closing time in minutes-from-midnight. Anchors where any
   *  member's service would end past this are filtered out so we never
   *  propose a slot that extends beyond closing time. */
  closeMin: number;
  resolvedMembers: ResolvedMember[];
  staffList: StaffRow[];
  staffById: Map<string, StaffRow>;
  capability: StaffCapabilityMap;
  existing: ExistingBooking[];
};

function findArrangementsInWindow(
  ctx: SchedulerSearchCtx,
): GroupArrangement[] {
  const maxMemberMin = ctx.resolvedMembers.reduce(
    (acc, m) => Math.max(acc, m.totalMinutes),
    0,
  );
  const dayCloseIso = salonWallTimeToUtcIso(ctx.date, ctx.closeMin, ctx.timezone);
  const dayCloseMs = Date.parse(dayCloseIso);

  const anchors: number[] = [];
  for (let mm = ctx.window.startMin; mm <= ctx.window.endMin; mm += SLOT_STEP_MIN) {
    const iso = salonWallTimeToUtcIso(ctx.date, mm, ctx.timezone);
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue;
    // Reject anchor if the longest member's service would end past closing.
    if (Number.isFinite(dayCloseMs) && ms + maxMemberMin * 60_000 > dayCloseMs) continue;
    anchors.push(ms);
  }
  if (anchors.length === 0) return [];

  let bestArrangement: GroupArrangement | null = null;
  let altArrangement: GroupArrangement | null = null;
  let earliestArrangement: GroupArrangement | null = null;

  for (const anchorMs of anchors) {
    if (!bestArrangement) {
      const aligned = tryAlignedArrangement(
        anchorMs,
        ctx.resolvedMembers,
        ctx.staffList,
        ctx.staffById,
        ctx.capability,
        ctx.existing,
        true,
      );
      if (aligned) {
        bestArrangement = buildArrangement(
          "best",
          aligned,
          ctx.resolvedMembers,
          ctx.staffById,
          ctx.timezone,
        );
      }
    }

    if (!altArrangement) {
      const staggered = tryStaggeredArrangement(
        anchorMs,
        ctx.resolvedMembers,
        ctx.staffList,
        ctx.staffById,
        ctx.capability,
        ctx.existing,
        ALT_SPREAD_LIMIT_MIN,
      );
      if (staggered) {
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
            ctx.resolvedMembers,
            ctx.staffById,
            ctx.timezone,
          );
        }
      }
    }

    if (!earliestArrangement) {
      const earliest = tryAlignedArrangement(
        anchorMs,
        ctx.resolvedMembers,
        ctx.staffList,
        ctx.staffById,
        ctx.capability,
        ctx.existing,
        false,
      );
      if (earliest) {
        earliestArrangement = buildArrangement(
          "earliest",
          earliest,
          ctx.resolvedMembers,
          ctx.staffById,
          ctx.timezone,
        );
      }
    }

    if (bestArrangement && altArrangement && earliestArrangement) break;
  }

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
      earliestArrangement.assignments.some(
        (a, i) =>
          bestArrangement!.assignments[i] &&
          a.staffId !== bestArrangement!.assignments[i].staffId,
      ))
  ) {
    arrangements.push(earliestArrangement);
  }

  return arrangements;
}

// ─── Sync-finish slot scan ───────────────────────────────────────

type FinishArrangementsCtx = {
  /** UTC ms of the desired finish time selected by the customer. */
  targetFinishMs: number;
  /** UTC ms of the salon's opening time (first valid start). */
  dayOpenMs: number;
  /** UTC ms of the salon's closing time (last valid finish). */
  dayCloseMs: number;
  date: string;
  timezone: string;
  resolvedMembers: ResolvedMember[];
  staffList: StaffRow[];
  staffById: Map<string, StaffRow>;
  capability: StaffCapabilityMap;
  existing: ExistingBooking[];
};

/**
 * Sync-finish search: all members end at the same target finish time.
 * Iterates candidate finish times and returns up to three arrangements:
 *
 *   1. BEST         — finish time closest to targetFinishMs, preferred
 *                     staff respected.
 *   2. ALTERNATIVE  — next-closest different finish time, preferred
 *                     staff respected.
 *   3. EARLIEST     — chronologically first valid finish time (ignores
 *                     preferred-staff so "just get me in" works).
 *
 * Unlike sync-start, spread is not used as a quality gate here — every
 * member ends at the same time so the "spread" (range of start times)
 * is simply the difference in service durations, which the customer
 * already accepted when picking their services.
 */
function findFinishArrangementsInWindow(
  ctx: FinishArrangementsCtx,
): GroupArrangement[] {
  const maxMemberMin = ctx.resolvedMembers.reduce(
    (acc, m) => Math.max(acc, m.totalMinutes),
    0,
  );
  if (maxMemberMin === 0) return [];

  // The earliest valid finish is when the longest service starts at dayOpen.
  const earliestFinish = ctx.dayOpenMs + maxMemberMin * 60_000;
  if (ctx.dayCloseMs <= earliestFinish) return [];

  // Generate all candidate finish times within [earliestFinish, dayCloseMs].
  const allFinishMs: number[] = [];
  for (
    let ms = earliestFinish;
    ms <= ctx.dayCloseMs;
    ms += SLOT_STEP_MIN * 60_000
  ) {
    allFinishMs.push(ms);
  }
  if (allFinishMs.length === 0) return [];

  // Sort a copy by distance from the target for best + alternative search.
  const byDistance = allFinishMs
    .slice()
    .sort(
      (a, b) =>
        Math.abs(a - ctx.targetFinishMs) - Math.abs(b - ctx.targetFinishMs),
    );

  let bestArrangement: GroupArrangement | null = null;
  let altArrangement: GroupArrangement | null = null;

  for (const finishMs of byDistance) {
    if (bestArrangement && altArrangement) break;
    const result = tryFinishAlignedArrangement(
      finishMs,
      ctx.dayOpenMs,
      ctx.resolvedMembers,
      ctx.staffList,
      ctx.staffById,
      ctx.capability,
      ctx.existing,
      /* respectPreferred */ true,
    );
    if (!result) continue;
    if (!bestArrangement) {
      bestArrangement = buildArrangement(
        "best",
        result,
        ctx.resolvedMembers,
        ctx.staffById,
        ctx.timezone,
      );
    } else if (finishMs !== bestArrangement.groupEndMs) {
      // Different finish time → a genuine second option.
      altArrangement = buildArrangement(
        "alternative",
        result,
        ctx.resolvedMembers,
        ctx.staffById,
        ctx.timezone,
      );
    }
  }

  // Earliest: chronologically first finish time, ignore preferred staff.
  let earliestArrangement: GroupArrangement | null = null;
  for (const finishMs of allFinishMs) {
    const result = tryFinishAlignedArrangement(
      finishMs,
      ctx.dayOpenMs,
      ctx.resolvedMembers,
      ctx.staffList,
      ctx.staffById,
      ctx.capability,
      ctx.existing,
      /* respectPreferred */ false,
    );
    if (!result) continue;
    const arr = buildArrangement(
      "earliest",
      result,
      ctx.resolvedMembers,
      ctx.staffById,
      ctx.timezone,
    );
    // Only include when it's distinct from best (different finish time).
    if (!bestArrangement || arr.groupEndMs !== bestArrangement.groupEndMs) {
      earliestArrangement = arr;
    }
    break; // found chronologically earliest
  }

  const arrangements: GroupArrangement[] = [];
  if (bestArrangement) arrangements.push(bestArrangement);
  if (altArrangement) arrangements.push(altArrangement);
  if (earliestArrangement) arrangements.push(earliestArrangement);
  return arrangements;
}

// ─── Smart alternatives (Task #05) ──────────────────────────────
// Sub-queries run in parallel against a per-query 5 s budget so
// the user sees alternatives within the same loading impression
// even if any one path stalls. `Promise.allSettled` (not `all`)
// is intentional — a single sub-query timing out should never
// hide the ones that succeeded.

type AlternativesCtx = {
  supabase: SupabaseClient;
  shopSlug: string;
  salonId: string;
  date: string;
  timezone: string;
  arrivalPref: GroupArrivalPreference;
  dayHours: { open: string; close: string; closed: boolean };
  window: { startMin: number; endMin: number };
  resolvedMembers: ResolvedMember[];
  staffList: StaffRow[];
  staffById: Map<string, StaffRow>;
  capability: StaffCapabilityMap;
  existing: ExistingBooking[];
  /** The raw `params.members` passed to the public function —
   *  needed to re-call `loadGroupSmartSchedule` for the
   *  next-date sub-query without losing preferred-staff info. */
  rawMembers: GroupSmartScheduleMemberInput[];
  /** Forwarded from params so next-date sub-queries use the same mode. */
  mode?: GroupSyncMode;
  /** Forwarded from params for next-date sub-queries in sync_finish mode. */
  finishTime?: string;
};

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
): Promise<T | { __timeout: true }> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ __timeout: true }), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve({ __timeout: true });
      },
    );
  });
}

function isTimeout<T>(x: T | { __timeout: true }): x is { __timeout: true } {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { __timeout?: true }).__timeout === true
  );
}

/** Convert a UTC ISO into salon-local wall HH:MM (24h). Used so
 *  alternative cards carry the same "HH:MM" shape that the rest
 *  of the flow uses for submission. */
function utcIsoToSalonHm(utcIso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(Date.parse(utcIso)));
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hh}:${mm}`;
}

/**
 * Split-option sub-query (Sub-query 1).
 *
 * Drops the LAST member (matches spec "members[N-1]") from the
 * resolved list and runs the normal arrangement search. If that
 * succeeds, walks forward from the main group's max end +
 * SPLIT_LATE_BUFFER_MIN looking for a single anchor where the
 * dropped member can be slotted onto a capable + free staff.
 *
 * Returns `null` when N === 2 (can't split a duo without becoming
 * an individual booking, which is a different flow) or when no
 * late slot can be found inside the day's opening hours.
 */
function computeSplitOption(ctx: AlternativesCtx): GroupAlternatives["splitOption"] {
  if (ctx.resolvedMembers.length < 3) return null;

  const mainMembers = ctx.resolvedMembers.slice(0, -1);
  const lateMember = ctx.resolvedMembers[ctx.resolvedMembers.length - 1];

  const mainArrangements = findArrangementsInWindow({
    date: ctx.date,
    timezone: ctx.timezone,
    window: ctx.window,
    closeMin: hmToMinutes(ctx.dayHours.close) ?? 0,
    resolvedMembers: mainMembers,
    staffList: ctx.staffList,
    staffById: ctx.staffById,
    capability: ctx.capability,
    existing: ctx.existing,
  });
  if (mainArrangements.length === 0) return null;
  // Use the BEST arrangement for the main group — most compact.
  const mainArrangement = mainArrangements[0];

  // Find the late slot. The earliest a late member can start is
  // the main group's max end + the buffer, rounded up to the
  // next SLOT_STEP_MIN grid line so the staff's chair turns at
  // a clean boundary.
  const mainMaxEndMs = Math.max(
    ...mainArrangement.assignments.map((a) => Date.parse(a.endUtcIso)),
  );
  const lateMinStartMs =
    mainMaxEndMs + SPLIT_LATE_BUFFER_MIN * 60_000;

  const closeMin = hmToMinutes(ctx.dayHours.close);
  if (closeMin === null) return null;
  const dayCloseIso = salonWallTimeToUtcIso(ctx.date, closeMin, ctx.timezone);
  const dayCloseMs = Date.parse(dayCloseIso);
  if (!Number.isFinite(dayCloseMs)) return null;

  // Walk forward from lateMinStartMs in SLOT_STEP_MIN ticks, try
  // every capable + still-free staff. The main group's slots are
  // already represented in soft-reservations through the standard
  // `existing` list (the main arrangement is in-memory and hasn't
  // been written to the DB), so we manually treat the main
  // arrangement as additional occupancy for this search.
  const augmentedExisting: ExistingBooking[] = [
    ...ctx.existing,
    ...mainArrangement.assignments.map((a) => ({
      staffId: a.staffId,
      startMs: Date.parse(a.startUtcIso),
      endMs: Date.parse(a.endUtcIso),
    })),
  ];

  const lateDurationMs = lateMember.totalMinutes * 60_000;
  for (let ms = lateMinStartMs; ms + lateDurationMs <= dayCloseMs; ms += SLOT_STEP_MIN * 60_000) {
    const endMs = ms + lateDurationMs;
    const candidateOrder: string[] = [];
    if (lateMember.preferredStaffId != null) {
      candidateOrder.push(lateMember.preferredStaffId);
    }
    for (const s of ctx.staffList) {
      if (s.id !== lateMember.preferredStaffId) candidateOrder.push(s.id);
    }
    for (const sid of candidateOrder) {
      if (!ctx.staffById.has(sid)) continue;
      if (!isStaffCapableForService(ctx.capability, sid, lateMember.serviceId)) continue;
      if (!staffIsFree(sid, ms, endMs, augmentedExisting, new Map())) continue;

      const staff = ctx.staffById.get(sid)!;
      const lateStartIso = new Date(ms).toISOString();
      const lateEndIso = new Date(endMs).toISOString();

      // Build a synthetic combined arrangement so the UI flow
      // through step 5 + the submit payload can index by
      // memberIndex naturally. Order matches the input member
      // order so `members[a.memberIndex]` lookups stay valid.
      const lateAssignment: GroupArrangementAssignment = {
        memberIndex: lateMember.index,
        staffId: sid,
        staffName: staff.name,
        startUtcIso: lateStartIso,
        endUtcIso: lateEndIso,
        startDisplay: formatInSalonTz(lateStartIso, ctx.timezone, "shortTime"),
        endDisplay: formatInSalonTz(lateEndIso, ctx.timezone, "shortTime"),
        durationMinutes: lateMember.totalMinutes,
        priceCents: lateMember.priceCents,
        memberName: lateMember.name,
        serviceName: lateMember.serviceName,
      };
      const combinedAssignments: GroupArrangementAssignment[] = [
        ...mainArrangement.assignments,
        lateAssignment,
      ].sort((a, b) => a.memberIndex - b.memberIndex);

      const mainTime = utcIsoToSalonHm(
        mainArrangement.assignments[0].startUtcIso,
        ctx.timezone,
      );
      const lateTime = utcIsoToSalonHm(lateStartIso, ctx.timezone);

      return {
        mainArrangement,
        mainTime,
        mainSize: mainMembers.length,
        lateTime,
        lateStaffId: sid,
        lateStaffName: staff.name,
        lateMemberIndex: lateMember.index,
        lateMemberName: lateMember.name,
        assignments: combinedAssignments,
      };
    }
  }
  return null;
}

/**
 * Next-available-date sub-query (Sub-query 2).
 *
 * Probes the next `ALTERNATIVE_SEARCH_DAYS` salon-local days
 * (starting tomorrow). For each candidate we re-call
 * `loadGroupSmartSchedule` with the same arrival pref + members
 * — yes, this re-fetches salon/services/staff/bookings per
 * candidate, but those queries are cheap and parallelizing them
 * keeps total wall-time bounded by `ALTERNATIVE_QUERY_TIMEOUT_MS`.
 *
 * `Promise.allSettled` returns every result; we walk them in
 * date order and pick the first day that returned `ok: true`.
 */
async function computeNextAvailableDate(
  ctx: AlternativesCtx,
): Promise<GroupAlternatives["nextAvailableDate"]> {
  const candidateDates: string[] = [];
  for (let i = 1; i <= ALTERNATIVE_SEARCH_DAYS; i++) {
    candidateDates.push(salonDateOffset(ctx.timezone, i));
  }

  const probes = candidateDates.map((ymd) =>
    loadGroupSmartSchedule(
      {
        shopSlug: ctx.shopSlug,
        date: ymd,
        arrivalPref: ctx.arrivalPref,
        members: ctx.rawMembers,
        // Forward mode + finishTime so sync_finish next-date probes
        // still target the same finish preference.
        mode: ctx.mode,
        finishTime: ctx.finishTime,
      },
      // Recursion guard — without this each candidate day would
      // fire its own next-date fan-out (5 × 5 = 25 probes per
      // failed call, 125 at depth 3, etc.).
      { skipAlternatives: true },
    ),
  );
  const settled = await Promise.allSettled(probes);

  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status !== "fulfilled") continue;
    const v = r.value;
    if (!v.ok) continue;
    if (v.arrangements.length === 0) continue;
    const arrangement = v.arrangements[0];
    const time = utcIsoToSalonHm(
      arrangement.assignments[0].startUtcIso,
      ctx.timezone,
    );
    return {
      date: candidateDates[i],
      arrangement,
      time,
    };
  }
  return null;
}

/**
 * Earlier-today sub-query (Sub-query 3).
 *
 * Flips the arrival window: morning ↔ afternoon. Evening flips
 * to morning (skipping afternoon, which is the closest "earlier"
 * but may still be too late if the user actually wanted morning).
 * `specific` returns null — the user already targeted an exact
 * time so "earlier than that" is ambiguous and we don't want to
 * second-guess them.
 *
 * Reuses the same loaded ctx (same date, same staff, same
 * bookings) — only the window changes, so no DB round-trip.
 */
function computeEarlierToday(
  ctx: AlternativesCtx,
): GroupAlternatives["earlierToday"] {
  let alternateWindow: { startMin: number; endMin: number } | null = null;

  if (ctx.arrivalPref.kind === "morning") {
    alternateWindow = windowForArrival(
      { kind: "afternoon" },
      ctx.dayHours,
    );
  } else if (
    ctx.arrivalPref.kind === "afternoon" ||
    ctx.arrivalPref.kind === "evening"
  ) {
    alternateWindow = windowForArrival(
      { kind: "morning" },
      ctx.dayHours,
    );
  }
  if (!alternateWindow) return null;

  const arrangements = findArrangementsInWindow({
    date: ctx.date,
    timezone: ctx.timezone,
    window: alternateWindow,
    closeMin: hmToMinutes(ctx.dayHours.close) ?? 0,
    resolvedMembers: ctx.resolvedMembers,
    staffList: ctx.staffList,
    staffById: ctx.staffById,
    capability: ctx.capability,
    existing: ctx.existing,
  });
  if (arrangements.length === 0) return null;
  const arrangement = arrangements[0];
  const time = utcIsoToSalonHm(
    arrangement.assignments[0].startUtcIso,
    ctx.timezone,
  );
  return { arrangement, time };
}

async function computeAlternatives(
  ctx: AlternativesCtx,
): Promise<GroupAlternatives> {
  // All three sub-queries race in parallel against the per-query
  // 5 s budget. Split + earlier-today are pure functions; we wrap
  // them in `Promise.resolve(...)` so the timeout helper sees a
  // uniform Promise shape. Next-available-date is genuinely
  // async (fans out to the next 5 days' schedulers).
  const [splitR, earlierR, nextDateR] = await Promise.all([
    withTimeout(
      Promise.resolve(computeSplitOption(ctx)),
      ALTERNATIVE_QUERY_TIMEOUT_MS,
    ),
    withTimeout(
      Promise.resolve(computeEarlierToday(ctx)),
      ALTERNATIVE_QUERY_TIMEOUT_MS,
    ),
    withTimeout(
      computeNextAvailableDate(ctx),
      ALTERNATIVE_QUERY_TIMEOUT_MS,
    ),
  ]);

  return {
    splitOption: isTimeout(splitR) ? null : splitR,
    earlierToday: isTimeout(earlierR) ? null : earlierR,
    nextAvailableDate: isTimeout(nextDateR) ? null : nextDateR,
  };
}
