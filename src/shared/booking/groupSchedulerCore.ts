/**
 * Pure scheduling engine for group bookings — no Supabase, no Next.js
 * server context, fully synchronous.
 *
 * Exported and imported by:
 *   - `loadGroupSmartSchedule.ts` (the "use server" orchestrator)
 *   - unit tests in `__tests__/groupSmartSchedule.test.ts`
 *
 * Nothing in this file may be async or depend on server-only modules.
 */

import { intervalsOverlapMs } from "@/shared/booking/bookingIntervals";
import {
  isStaffCapableForService,
  type StaffCapabilityMap,
} from "@/shared/booking/staffCapability";
import { formatInSalonTz } from "@/shared/lib/salonTime";

// ─── Shared types ────────────────────────────────────────────────

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
  /** Wave this member belongs to. 1 for normal (single-wave) bookings;
   *  2, 3 … for later waves of a large group split across time (Phase 6). */
  waveNumber: number;
};

/** Per-wave roll-up for UI / voice summaries (Phase 6 Wave Booking). */
export type WaveSummary = {
  waveNumber: number;
  /** Earliest start in this wave (UTC ms). */
  startMs: number;
  /** Latest end in this wave (UTC ms). */
  endMs: number;
  startDisplay: string;
  endDisplay: string;
  memberCount: number;
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
  /** True when the group was split across multiple time waves because it could
   *  not be served simultaneously (Phase 6). False for normal arrangements. */
  isWaveBooking: boolean;
  /** Number of waves. 1 for normal (non-wave) arrangements. */
  waveCount: number;
  /** Per-wave roll-up (always length === waveCount; single entry when normal). */
  waves: WaveSummary[];
  /** Plain-English one-liner for UI / voice, e.g.
   *  "Split into 2 waves: 6 guests at 2:00 PM and 4 guests at 3:15 PM." */
  summary: string;
};

// ─── Internal types ──────────────────────────────────────────────

export type ResolvedMember = {
  /** Input index. */
  index: number;
  name: string;
  serviceId: string;
  serviceName: string;
  /** Total minutes (duration + buffer) for occupancy math. */
  totalMinutes: number;
  /** Per-service buffer ("Chuẩn bị (phút)") in minutes. Drives the
   *  inter-wave gap so the chair-reset time the operator configured is
   *  what shows on the calendar — not a hardcoded 15. Optional: when a
   *  caller omits it, wave scheduling falls back to WAVE_BUFFER_MIN. */
  bufferMinutes?: number;
  priceCents: number | null;
  preferredStaffId: string | null;
};

export type StaffRow = { id: string; name: string };

export type ExistingBooking = {
  staffId: string;
  startMs: number;
  endMs: number;
};

export type FinishArrangementsCtx = {
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

// ─── Constants ───────────────────────────────────────────────────

export const SLOT_STEP_MIN = 15;

/** Phase 6 — fallback gap inserted between the end of one wave and the start of
 *  the next so staff have time to reset between back-to-back guests. Used only
 *  when no member in the wave carries a per-service `bufferMinutes` (and no
 *  explicit `opts.waveBufferMin` is passed); otherwise the gap is derived from
 *  the service buffer the operator configured. */
export const WAVE_BUFFER_MIN = 15;

/** Safety ceiling on wave count so a pathological input can't loop forever. */
export const MAX_WAVES = 6;

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Check whether `staffId` is free for `[startMs, endMs)` against
 * existing bookings + an in-arrangement "soft" reservations map.
 */
export function staffIsFree(
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

// ─── Core assignment functions ───────────────────────────────────

/**
 * Assign each member to a staff at the given anchor (all members
 * start at `anchorMs`). Returns the assignments or `null` if the
 * combination is infeasible. `respectPreferred` controls whether a
 * member with a non-null `preferredStaffId` may fall back to any
 * other capable staff.
 */
export function tryAlignedArrangement(
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
 * Sync-finish assignment: ALL members end at exactly `targetFinishMs`.
 * Member i starts at `targetFinishMs − member_i.totalMinutes × 60_000`.
 * Longer services start earlier — they are processed first so the
 * hardest-to-fill (earliest-start) slots are locked before shorter ones.
 * Returns null if any member's start would fall before `dayOpenMs` or
 * no capable, free staff can be found.
 */
export function tryFinishAlignedArrangement(
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
  const order = slots.slice().sort((a, b) => {
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

// ─── Arrangement builder ─────────────────────────────────────────

export function buildArrangement(
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
      waveNumber: 1,
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
  const groupStartDisplay = formatInSalonTz(groupStartIso, timezone, "shortTime");
  const groupEndDisplay = formatInSalonTz(groupEndIso, timezone, "shortTime");
  return {
    kind,
    groupStartMs,
    groupEndMs,
    groupStartDisplay,
    groupEndDisplay,
    spreadMinutes,
    totalCents,
    assignments,
    // Normal arrangement = one wave.
    isWaveBooking: false,
    waveCount: 1,
    waves: [
      {
        waveNumber: 1,
        startMs: groupStartMs,
        endMs: groupEndMs,
        startDisplay: groupStartDisplay,
        endDisplay: groupEndDisplay,
        memberCount: assignments.length,
      },
    ],
    summary: `${assignments.length} ${assignments.length === 1 ? "guest" : "guests"} at ${groupStartDisplay}.`,
  };
}

// ─── Wave scheduling (Phase 6 — sync_start only) ─────────────────

export type WaveRawAssignment = {
  memberIdx: number;
  staffId: string;
  startMs: number;
  endMs: number;
  waveNumber: number;
};

/**
 * Wave fallback for sync_start large groups. Call this ONLY after
 * `tryAlignedArrangement` returns null (the whole group can't start at once
 * because capacity is exceeded) — never as a replacement for it.
 *
 * Greedy fill: wave 1 starts at `anchorMs` and seats as many members as there
 * are capable, free staff. Whoever is left forms wave 2, starting at
 * (wave 1's latest end + the wave gap); repeat until everyone is seated.
 *
 * The wave gap is, in priority order: `opts.waveBufferMin` when given, else the
 * largest `bufferMinutes` among the members seated in the just-finished wave
 * (so the chair-reset time the operator configured on the service is what the
 * schedule reflects), else `WAVE_BUFFER_MIN` as a last-resort fallback.
 *
 * Each wave reuses the existing capability + `staffIsFree` checks. Earlier waves
 * are appended to a private occupancy copy so the same staff is never
 * double-booked — and because later waves start strictly after earlier ones end
 * (+ buffer), their intervals never overlap.
 *
 * Returns null when the group can't be served even across waves (a service no
 * active staff can do, or it can't fit before close).
 */
export function tryWaveArrangement(
  anchorMs: number,
  members: ResolvedMember[],
  staff: readonly StaffRow[],
  staffById: Map<string, StaffRow>,
  capability: StaffCapabilityMap,
  existing: ExistingBooking[],
  dayCloseMs: number,
  opts?: { waveBufferMin?: number; maxWaves?: number },
): { assignments: WaveRawAssignment[] } | null {
  const explicitWaveBufferMin = opts?.waveBufferMin;
  const maxWaves = opts?.maxWaves ?? MAX_WAVES;

  // Private occupancy copy — earlier waves get appended so later waves see them.
  const occupancy: ExistingBooking[] = existing.slice();
  const out: WaveRawAssignment[] = [];

  let remaining = members.slice();
  let waveNumber = 1;
  let waveStartMs = anchorMs;

  while (remaining.length > 0) {
    if (waveNumber > maxWaves) return null;

    // Preferred-staff members first (hard constraint), mirroring tryAlignedArrangement.
    const order = remaining
      .map((m, i) => ({ m, i }))
      .sort((a, b) => {
        const ap = a.m.preferredStaffId != null ? 0 : 1;
        const bp = b.m.preferredStaffId != null ? 0 : 1;
        return ap - bp;
      })
      .map((e) => e.m);

    const soft = new Map<string, Array<{ startMs: number; endMs: number }>>();
    const thisWave: Array<{ staffId: string; startMs: number; endMs: number }> = [];
    const stillRemaining: ResolvedMember[] = [];
    let waveMaxEndMs = waveStartMs;
    // Largest per-service buffer among members seated this wave — drives the
    // gap before the next wave when no explicit override is supplied.
    let waveMaxBufferMin = 0;

    for (const m of order) {
      const startMs = waveStartMs;
      const endMs = waveStartMs + m.totalMinutes * 60_000;
      // Doesn't fit before close at this wave time → defer to a later attempt
      // (a later wave is even later, so it won't fit either, but the no-progress
      // guard below turns that into a clean null rather than an infinite loop).
      if (endMs > dayCloseMs) {
        stillRemaining.push(m);
        continue;
      }

      const candidateOrder: string[] = [];
      if (m.preferredStaffId != null) {
        candidateOrder.push(m.preferredStaffId);
        for (const s of staff) if (s.id !== m.preferredStaffId) candidateOrder.push(s.id);
      } else {
        for (const s of staff) candidateOrder.push(s.id);
      }

      let picked: string | null = null;
      for (const sid of candidateOrder) {
        if (!staffById.get(sid)) continue;
        if (!isStaffCapableForService(capability, sid, m.serviceId)) continue;
        if (!staffIsFree(sid, startMs, endMs, occupancy, soft)) continue;
        picked = sid;
        break;
      }
      if (picked === null) {
        stillRemaining.push(m);
        continue;
      }

      const bucket = soft.get(picked) ?? [];
      bucket.push({ startMs, endMs });
      soft.set(picked, bucket);
      out.push({ memberIdx: m.index, staffId: picked, startMs, endMs, waveNumber });
      thisWave.push({ staffId: picked, startMs, endMs });
      if (endMs > waveMaxEndMs) waveMaxEndMs = endMs;
      if (m.bufferMinutes != null && m.bufferMinutes > waveMaxBufferMin) {
        waveMaxBufferMin = m.bufferMinutes;
      }
    }

    // No member could be seated this wave → unservable (prevents infinite loop).
    if (thisWave.length === 0) return null;

    // Commit this wave so later waves never reuse a busy interval.
    for (const a of thisWave) occupancy.push({ staffId: a.staffId, startMs: a.startMs, endMs: a.endMs });

    remaining = stillRemaining;
    if (remaining.length === 0) break;

    const gapMin =
      explicitWaveBufferMin ?? (waveMaxBufferMin > 0 ? waveMaxBufferMin : WAVE_BUFFER_MIN);
    waveStartMs = waveMaxEndMs + gapMin * 60_000;
    waveNumber++;
  }

  out.sort((a, b) => a.waveNumber - b.waveNumber || a.memberIdx - b.memberIdx);
  return { assignments: out };
}

/**
 * Forward-scanning wrapper around `tryWaveArrangement`.
 *
 * The bare scheduler anchors wave 1 at a single start time and bails (null) the
 * moment no staff is free at that exact tick — so a group whose requested window
 * is fully booked dead-ends with "no slots today" even when later in the day is
 * wide open (e.g. mornings booked solid, afternoon empty). This walks the wave-1
 * anchor forward in `SLOT_STEP_MIN` ticks from `fromMs` to `dayCloseMs` and
 * returns the FIRST anchor at which the WHOLE group fits across waves — i.e. the
 * earliest complete arrangement at or after the requested time. When the
 * requested time is already free the first tick succeeds, so the happy path is
 * unchanged. Returns null only when the group cannot be fully seated before
 * close at any start time.
 */
export function findEarliestWaveArrangement(
  fromMs: number,
  members: ResolvedMember[],
  staff: readonly StaffRow[],
  staffById: Map<string, StaffRow>,
  capability: StaffCapabilityMap,
  existing: ExistingBooking[],
  dayCloseMs: number,
  opts?: { waveBufferMin?: number; maxWaves?: number },
): { assignments: WaveRawAssignment[] } | null {
  const stepMs = SLOT_STEP_MIN * 60_000;
  for (let anchor = fromMs; anchor < dayCloseMs; anchor += stepMs) {
    const raw = tryWaveArrangement(
      anchor,
      members,
      staff,
      staffById,
      capability,
      existing,
      dayCloseMs,
      opts,
    );
    if (raw && raw.assignments.length === members.length) return raw;
  }
  return null;
}

/** Joins per-wave phrases naturally: "A and B" / "A, B, and C". */
function joinWavePhrases(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/**
 * Builds a wave-aware GroupArrangement from raw wave assignments. The
 * assignments span multiple start times (one cluster per wave); each carries its
 * waveNumber, and `waves[]` rolls them up for UI / voice. `isWaveBooking` is true
 * whenever there is more than one wave.
 */
export function buildWaveArrangement(
  raw: { assignments: WaveRawAssignment[] },
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
      waveNumber: a.waveNumber,
    };
  });

  // Roll up per wave.
  const waveNumbers = [...new Set(raw.assignments.map((a) => a.waveNumber))].sort((x, y) => x - y);
  const waves: WaveSummary[] = waveNumbers.map((wn) => {
    const inWave = raw.assignments.filter((a) => a.waveNumber === wn);
    let ws = Number.POSITIVE_INFINITY;
    let we = Number.NEGATIVE_INFINITY;
    for (const a of inWave) {
      if (a.startMs < ws) ws = a.startMs;
      if (a.endMs > we) we = a.endMs;
    }
    const wsIso = new Date(ws).toISOString();
    const weIso = new Date(we).toISOString();
    return {
      waveNumber: wn,
      startMs: ws,
      endMs: we,
      startDisplay: formatInSalonTz(wsIso, timezone, "shortTime"),
      endDisplay: formatInSalonTz(weIso, timezone, "shortTime"),
      memberCount: inWave.length,
    };
  });

  const waveCount = waves.length;
  const isWaveBooking = waveCount > 1;

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
  const groupStartDisplay = formatInSalonTz(groupStartIso, timezone, "shortTime");
  const groupEndDisplay = formatInSalonTz(groupEndIso, timezone, "shortTime");

  const summary = isWaveBooking
    ? `Split into ${waveCount} waves: ${joinWavePhrases(
        waves.map((w) => `${w.memberCount} ${w.memberCount === 1 ? "guest" : "guests"} at ${w.startDisplay}`),
      )}.`
    : `${assignments.length} ${assignments.length === 1 ? "guest" : "guests"} at ${groupStartDisplay}.`;

  return {
    kind: "best",
    groupStartMs,
    groupEndMs,
    groupStartDisplay,
    groupEndDisplay,
    spreadMinutes: Math.round((groupEndMs - groupStartMs) / 60_000),
    totalCents,
    assignments,
    isWaveBooking,
    waveCount,
    waves,
    summary,
  };
}

// ─── Sync-finish slot scan ───────────────────────────────────────

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
export function findFinishArrangementsInWindow(
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
    // Only include when it's distinct from best (different finish time OR
    // different staff assignments — respectPreferred=false may yield a
    // different crew at the same time, which is still a distinct option).
    if (
      !bestArrangement ||
      arr.groupEndMs !== bestArrangement.groupEndMs ||
      arr.assignments.some(
        (a, i) =>
          bestArrangement!.assignments[i] &&
          a.staffId !== bestArrangement!.assignments[i].staffId,
      )
    ) {
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
