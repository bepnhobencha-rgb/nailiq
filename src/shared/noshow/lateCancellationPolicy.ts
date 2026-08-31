export type LateCancellationBookingPolicy = {
  createdAt: string;
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
  shortNoticeBooking: boolean;
  graceActive: boolean;
  graceEndsAt: string | null;
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
const SHORT_NOTICE_GRACE_MINUTES = 15;
const MAX_LATE_CANCELLATION_PERCENT = 20;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

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
  const configuredSelfCancelPercent = nonNegativeInteger(
    policy.selfCancelFeePercent,
  );
  const selfCancelPercent = Math.min(
    configuredSelfCancelPercent ?? noShowPercent,
    MAX_LATE_CANCELLATION_PERCENT,
  );

  if (noShowPercent > 0) {
    return Math.round((snapshotCents * selfCancelPercent) / noShowPercent);
  }
  // Without the percentage that produced the saved fee snapshot there is no
  // authoritative way to prove the 20% ceiling. Fail closed instead of
  // treating an opaque amount as chargeable.
  return 0;
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
  const createdMs = Date.parse(booking.createdAt);
  const startPast = !Number.isFinite(startMs) || startMs <= nowMs;
  const shortNoticeBooking = Number.isFinite(startMs) &&
    Number.isFinite(createdMs) &&
    startMs > createdMs &&
    startMs - createdMs <= windowHours(salon) * HOUR_MS;
  const graceEndsMs = shortNoticeBooking
    ? createdMs + SHORT_NOTICE_GRACE_MINUTES * MINUTE_MS
    : Number.NaN;
  const graceActive = shortNoticeBooking && nowMs <= graceEndsMs;
  const graceEndsAt = Number.isFinite(graceEndsMs)
    ? new Date(graceEndsMs).toISOString()
    : null;
  const currentWithinWindow =
    !startPast && (startMs - nowMs) / HOUR_MS < windowHours(salon);

  const lockedAtMs = booking.selfCancelFeeLockedAt
    ? Date.parse(booking.selfCancelFeeLockedAt)
    : Number.NaN;
  const policyLockedByReschedule = Number.isFinite(lockedAtMs);
  const withinWindow =
    !startPast && !graceActive &&
    (currentWithinWindow || policyLockedByReschedule);

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
    shortNoticeBooking,
    graceActive,
    graceEndsAt,
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
  bookingCreatedAt: string;
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
  const createdMs = Date.parse(input.bookingCreatedAt);
  const shortNoticeGraceActive = Number.isFinite(previousStartMs) &&
    Number.isFinite(createdMs) &&
    previousStartMs > createdMs &&
    previousStartMs - createdMs <= windowHours(input.salon) * HOUR_MS &&
    nowMs <= createdMs + SHORT_NOTICE_GRACE_MINUTES * MINUTE_MS;
  if (shortNoticeGraceActive) return null;
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
