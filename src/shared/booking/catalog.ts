/**
 * Types and helpers for the public booking service list (loaded server-side from Supabase).
 */

export type BookingServiceItem = {
  id: string;
  name: string;
  durationMinutes: number;
  bufferMinutes: number;
  /** Total length in minutes (service duration + buffer), for tiles + blocking. */
  totalMinutes: number;
  /** Snapshot from `services.price_cents`; optional display string. */
  priceCents: number | null;
  priceDisplay: string | null;
};

export function getServiceById(
  services: readonly BookingServiceItem[],
  id: string,
): BookingServiceItem | undefined {
  return services.find((s) => s.id === id);
}
