/**
 * Square caps Payment.reference_id at 40 characters. A booking UUID is stable,
 * tenant-safe for this lookup, and fits without the old `booking:` prefix.
 */
export function noShowPaymentReferenceId(bookingId: string): string {
  return bookingId.trim().slice(0, 40);
}
