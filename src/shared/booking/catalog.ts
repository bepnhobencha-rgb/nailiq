/**
 * Types and helpers for the public booking service list (loaded server-side from Supabase).
 */

export type BookingServiceItem = {
  id: string;
  name: string;
};

export function getServiceById(
  services: readonly BookingServiceItem[],
  id: string,
): BookingServiceItem | undefined {
  return services.find((s) => s.id === id);
}
