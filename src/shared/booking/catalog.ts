/**
 * Types and helpers for the public booking service list (loaded server-side from Supabase).
 */

export type BookingServiceItem = {
  id: string;
  name: string;
  /** Total length in minutes (service duration + buffer), for tiles. */
  totalMinutes: number;
  /** When the backend exposes pricing, surfaced here; otherwise null. */
  priceDisplay: string | null;
};

export function getServiceById(
  services: readonly BookingServiceItem[],
  id: string,
): BookingServiceItem | undefined {
  return services.find((s) => s.id === id);
}
