/**
 * Types and helpers for the public booking service list (loaded server-side from Supabase).
 */
import type { ServiceCategory } from "@/shared/booking/serviceCategory";

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
  /** From `services.category` (migration 20260511500000). Defaults to
   * `"other"` for legacy rows. Used by the public booking page to group
   * tiles under category headings. */
  category: ServiceCategory;
};

export function getServiceById(
  services: readonly BookingServiceItem[],
  id: string,
): BookingServiceItem | undefined {
  return services.find((s) => s.id === id);
}
