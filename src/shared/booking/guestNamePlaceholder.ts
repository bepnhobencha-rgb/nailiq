/**
 * Group bookings default each member's name to a placeholder like
 * "Guest 2" / "Khách 2" when the organizer doesn't type a real name.
 * That placeholder must NEVER be persisted as a customer's profile name
 * (client_profiles.name) — otherwise the returning-customer recognition
 * later greets them as "Guest 2".
 *
 * Single source of truth so the API lookup, the group-booking upsert,
 * and the gate UI all agree on what counts as "not a real name".
 */
export function isPlaceholderGuestName(name: string | null | undefined): boolean {
  if (!name) return true;
  return /^(guest|khách|khach)\s*\d*$/i.test(name.trim());
}

/** Returns the name if it's a real name, else "" (empty). */
export function realNameOrEmpty(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  return isPlaceholderGuestName(trimmed) ? "" : trimmed;
}
