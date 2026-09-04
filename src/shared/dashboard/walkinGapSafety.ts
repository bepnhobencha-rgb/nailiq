import { serviceBlockMinutes } from "@/shared/booking/bookingBlock";
import type { StaffAvailability } from "@/shared/dashboard/availabilityEngine";

export type WalkinServiceBlock = {
  duration_minutes: number;
  buffer_minutes?: number | null;
};

function blockedCandidate(candidate: StaffAvailability): StaffAvailability {
  return {
    ...candidate,
    isAvailableNow: false,
    estimatedReadyAt: null,
    waitMinutes: 0,
    confidenceLevel: "low",
  };
}

/**
 * Project the earliest gap in which a walk-in's complete occupied block fits.
 *
 * `availabilityEngine` answers whether a technician is idle at this instant.
 * That is not enough for an immediate walk-in: the service plus cleanup buffer
 * must also finish before the technician's next reservation. This pure client-
 * side projection prevents a misleading "Ready now" recommendation while the
 * server's conflict checks remain the final write-time authority.
 */
export function projectWalkinGapSafety(
  candidate: StaffAvailability,
  nowIso: string,
  service: WalkinServiceBlock,
): StaffAvailability {
  const nowMs = Date.parse(nowIso);
  const duration = Number(service.duration_minutes);
  const buffer = Number(service.buffer_minutes ?? 0);
  const blockMinutes = serviceBlockMinutes(duration, buffer);

  // A missing/invalid catalog duration cannot safely produce an immediate
  // assignment. Match the server action's fail-closed duration/buffer rules.
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(duration) ||
    duration < 1 ||
    !Number.isFinite(buffer) ||
    buffer < 0 ||
    !Number.isFinite(blockMinutes) ||
    blockMinutes < 1
  ) {
    return blockedCandidate(candidate);
  }

  const blockMs = blockMinutes * 60_000;
  const reservations = candidate.reservations
    .map((reservation) => ({
      reservation,
      startsAtMs: Date.parse(reservation.occupiedStartsAt),
      endsAtMs: Date.parse(reservation.occupiedEndsAt),
    }))
    .filter(({ reservation }) => reservation.staffId === candidate.staffId);

  // Malformed authoritative reservation data must never be interpreted as a
  // free gap. The server will also reject a conflicting write, but the UI must
  // not invite the receptionist to make that attempt.
  if (
    reservations.some(
      ({ startsAtMs, endsAtMs }) =>
        !Number.isFinite(startsAtMs) ||
        !Number.isFinite(endsAtMs) ||
        endsAtMs <= startsAtMs,
    )
  ) {
    return blockedCandidate(candidate);
  }

  let gapStartsAtMs = nowMs;
  for (const { startsAtMs, endsAtMs } of reservations.sort(
    (a, b) => a.startsAtMs - b.startsAtMs,
  )) {
    if (endsAtMs <= gapStartsAtMs) continue;

    // Half-open booking windows allow a service to finish exactly when the
    // next reservation starts, consistent with the database overlap guard.
    if (gapStartsAtMs + blockMs <= startsAtMs) break;
    gapStartsAtMs = Math.max(gapStartsAtMs, endsAtMs);
  }

  const isAvailableNow = gapStartsAtMs === nowMs;
  return {
    ...candidate,
    isAvailableNow,
    estimatedReadyAt: new Date(gapStartsAtMs).toISOString(),
    waitMinutes: isAvailableNow
      ? 0
      : Math.max(1, Math.ceil((gapStartsAtMs - nowMs) / 60_000)),
  };
}

/** Select an explicit technician, or the first ranked technician with a safe
 * immediate gap. If nobody fits now, preserve ranking and show the first
 * candidate's projected next safe time. */
export function selectWalkinGapSafeRecommendation(
  staff: readonly StaffAvailability[],
  nowIso: string,
  service: WalkinServiceBlock,
  selectedStaffId: string,
): StaffAvailability | null {
  if (staff.length === 0) return null;

  if (selectedStaffId !== "") {
    const selected = staff.find(
      (candidate) => candidate.staffId === selectedStaffId,
    );
    return selected ? projectWalkinGapSafety(selected, nowIso, service) : null;
  }

  const projected = staff.map((candidate) =>
    projectWalkinGapSafety(candidate, nowIso, service),
  );
  return (
    projected.find((candidate) => candidate.isAvailableNow) ??
    projected[0] ??
    null
  );
}
