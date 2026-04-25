/**
 * Persists a public booking. Stub until a real API exists.
 */

export type PublicBookingPayload = {
  shopSlug: string;
  serviceId: string;
  timeSlot: string;
};

export type PublicBookingResult = { ok: true };

/**
 * @returns Resolves when the booking is accepted (mock).
 */
export async function submitPublicBooking(
  _payload: PublicBookingPayload,
): Promise<PublicBookingResult> {
  await new Promise((r) => {
    setTimeout(r, 400);
  });
  return { ok: true };
}
