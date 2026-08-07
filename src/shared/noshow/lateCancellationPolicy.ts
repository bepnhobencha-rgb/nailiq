export type LateCancellationBookingPolicy = {
  startTimeUtc: string;
  noShowFeeCents: number | null;
  noShowCardId: string | null;
  noShowConsentAt: string | null;
  noShowChargeStatus: string | null;
  selfCancelFeeLockedAt?: string | null;
  selfCancelFeeLockedCents?: number | null;
};

export type LateCancellationSalonPolicy = {
  selfCancelFeeEnabled: boolean | null;
  selfCancelWindowHours: number | null;
  selfCancelFeePercent: number | null;
  noShowFeePercent: number | null;
};

export type LateCancellationEvaluation = {
  startPast: boolean;
  currentWithinWindow: boolean;
  policyLockedByReschedule: boolean;
  withinWindow: boolean;
  feeCents: number;
  hasChargeableCard: boolean;
  willCharge: boolean;
};

export type LateCancellationLockPatch = {
  self_cancel_fee_locked_at: string;
  self_cancel_fee_locked_cents: number;
  self_cancel_fee_lock_reason: "customer_reschedule" | "voice_reschedule";
};

const DEFAULT_WINDOW_HOURS = 24;
const HOUR_MS = 3_600_000;

function positiveInteger(value: number | null | undefined): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.round(Number(value))
    : 0;
}

function nonNegativeInteger(value: number | null | undefined): number | null {
  return Number.isFinite(value) && Number(value) >= 0
    ? Math.round(Number(value))
    : null;
}

function windowHours(policy: LateCancellationSalonPolicy): number {
  const configured = positiveInteger(policy.selfCancelWindowHours);
  return configured > 0 ? configured : DEFAULT_WINDOW_HOURS;
}

export function calculateLateCancellationFeeCents(
  noShowFeeCents: number | null,
  policy: LateCancellationSalonPolicy,
): number {
  const snapshotCents = positiveInteger(noShowFeeCents);
  const noShowPercent = positiveInteger(policy.noShowFeePercent);
  const selfCancelPercent = nonNegativeInteger(policy.selfCancelFeePercent);

  if (selfCancelPercent !== null && noShowPercent > 0) {
    return Math.round((snapshotCents * selfCancelPercent) / noShowPercent);
  }
  return snapshotCents;
}

/**
 * Server-authoritative late-cancellation decision shared by public web and the
 * AI receptionist. A customer reschedule can lock the policy, but can never
 * unlock it by moving the appointment farther into the future.
 */
export function evaluateLateCancellationPolicy(input: {
  booking: LateCancellationBookingPolicy;
  salon: LateCancellationSalonPolicy;
  nowMs?: number;
}): LateCancellationEvaluation {
  const { booking, salon } = input;
  const nowMs = input.nowMs ?? Date.now();
  const startMs = Date.parse(booking.startTimeUtc);
  const startPast = !Number.isFinite(startMs) || startMs <= nowMs;
  const currentWithinWindow =
    !startPast && (startMs - nowMs) / HOUR_MS < windowHours(salon);

  const lockedAtMs = booking.selfCancelFeeLockedAt
    ? Date.parse(booking.selfCancelFeeLockedAt)
    : Number.NaN;
  const policyLockedByReschedule = Number.isFinite(lockedAtMs);
  const withinWindow =
    !startPast && (currentWithinWindow || policyLockedByReschedule);

  const lockedCents = positiveInteger(booking.selfCancelFeeLockedCents);
  const feeCents =
    policyLockedByReschedule && lockedCents > 0
      ? lockedCents
      : calculateLateCancellationFeeCents(booking.noShowFeeCents, salon);

  const hasChargeableCard =
    Boolean(booking.noShowCardId) &&
    Boolean(booking.noShowConsentAt) &&
    feeCents > 0 &&
    booking.noShowChargeStatus !== "charged";
  const willCharge =
    salon.selfCancelFeeEnabled === true && withinWindow && hasChargeableCard;

  return {
    startPast,
    currentWithinWindow,
    policyLockedByReschedule,
    withinWindow,
    feeCents,
    hasChargeableCard,
    willCharge,
  };
}

/**
 * Snapshot the late fee when a customer-controlled reschedule happens after
 * the original appointment entered its cancellation window. Existing locks
 * are immutable; repeated reschedules cannot reset the amount or timestamp.
 */
export function buildLateCancellationLockPatch(input: {
  previousStartTimeUtc: string;
  noShowFeeCents: number | null;
  existingLockedAt?: string | null;
  existingLockedCents?: number | null;
  salon: LateCancellationSalonPolicy;
  reason: "customer_reschedule" | "voice_reschedule";
  nowMs?: number;
}): LateCancellationLockPatch | null {
  if (input.existingLockedAt || input.salon.selfCancelFeeEnabled !== true) {
    return null;
  }

  const nowMs = input.nowMs ?? Date.now();
  const previousStartMs = Date.parse(input.previousStartTimeUtc);
  const insideWindow =
    Number.isFinite(previousStartMs) &&
    previousStartMs > nowMs &&
    (previousStartMs - nowMs) / HOUR_MS < windowHours(input.salon);
  if (!insideWindow) return null;

  const feeCents = calculateLateCancellationFeeCents(
    input.noShowFeeCents,
    input.salon,
  );
  if (feeCents <= 0) return null;

  return {
    self_cancel_fee_locked_at: new Date(nowMs).toISOString(),
    self_cancel_fee_locked_cents: feeCents,
    self_cancel_fee_lock_reason: input.reason,
  };
}
