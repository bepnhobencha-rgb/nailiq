import { serviceBlockMinutes } from "@/shared/booking/bookingBlock";

export type BookingTimingSegment = {
  durationMinutes: unknown;
  bufferMinutes: unknown;
  /** Concurrent add-ons do not extend the appointment timeline. */
  concurrent?: boolean;
};

export type BookingTiming = {
  /** Full occupied interval stored on the booking, including the final buffer. */
  blockMinutes: number;
  /**
   * Minutes from start until the customer's services are complete.
   *
   * Buffers between sequential services remain inside this span. Only the
   * final trailing reset/cleanup buffer is excluded, because no customer is
   * still receiving a service during that final gap.
   */
  serviceCompletionMinutes: number;
  /** Final cleanup buffer that may run after the salon closes. */
  trailingBufferMinutes: number;
};

function nonNegativeMinutes(value: unknown): number {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

/**
 * Shared timing model for closing-time validation.
 *
 * A booking continues to occupy staff/resource capacity for the full block,
 * but closing-hours eligibility is based on when the customer's last
 * sequential service finishes. This keeps availability, mutations and the
 * database boundary aligned without dropping cleanup buffers from conflict
 * protection.
 */
export function computeBookingTiming(
  main: BookingTimingSegment,
  addOns: readonly BookingTimingSegment[] = [],
): BookingTiming {
  const mainDuration = nonNegativeMinutes(main.durationMinutes);
  const mainBuffer = nonNegativeMinutes(main.bufferMinutes);

  let blockMinutes = serviceBlockMinutes(mainDuration, mainBuffer);
  let trailingBufferMinutes = mainBuffer;

  for (const addOn of addOns) {
    if (addOn.concurrent) continue;
    const duration = nonNegativeMinutes(addOn.durationMinutes);
    const buffer = nonNegativeMinutes(addOn.bufferMinutes);
    blockMinutes += serviceBlockMinutes(duration, buffer);
    trailingBufferMinutes = buffer;
  }

  return {
    blockMinutes,
    serviceCompletionMinutes: Math.max(
      0,
      blockMinutes - trailingBufferMinutes,
    ),
    trailingBufferMinutes,
  };
}
