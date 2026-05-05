import { BOOKING_GUEST_NAME_MAX } from "@/shared/booking/bookingGuestContactLimits";

/** Letters (incl. Vietnamese), combining marks, digits, ASCII space, `'`, `-`, `.` */
const SAFE_NAME_REGEX = /^[\p{L}\p{M}0-9\s'\-.]+$/u;

/**
 * Rejects XSS-prone punctuation and scripting; allows unicode letters / combining accents.
 * Empty after trim → false; longer than {@link BOOKING_GUEST_NAME_MAX} → false.
 */
export function isValidCustomerName(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > BOOKING_GUEST_NAME_MAX) return false;
  return SAFE_NAME_REGEX.test(trimmed);
}

/** Trim + length-cap only. Does NOT sanitize XSS — use {@link isValidCustomerName} for safety. */
export function trimCustomerName(input: string): string {
  return input.trim().slice(0, BOOKING_GUEST_NAME_MAX);
}
