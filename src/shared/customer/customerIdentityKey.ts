/**
 * Stable salon-analytics identity for a booking.
 *
 * Reversible identity review assigns every aliased booking to the canonical
 * client profile while deliberately preserving the phone captured at booking
 * time. Analytics must therefore prefer `client_profile_id`; using the raw
 * phone would split one reviewed customer back into multiple people.
 *
 * Legacy bookings may not have a profile yet, so a normalized phone remains a
 * bounded fallback instead of silently dropping the customer from reports.
 */
export function customerIdentityKey(input: {
  clientProfileId?: string | null;
  clientPhone?: string | null;
}): string | null {
  const profileId = input.clientProfileId?.trim();
  if (profileId) return `profile:${profileId}`;

  const phone = input.clientPhone?.replace(/\D/g, "") ?? "";
  return phone ? `phone:${phone}` : null;
}
