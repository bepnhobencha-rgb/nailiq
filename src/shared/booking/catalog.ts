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
  /** From `services.description` (migration 20260511600000). One-line
   * marketing copy shown under the service name. `null` → hide the line. */
  description: string | null;
  /** From `services.is_popular`. Renders a "Popular" badge on the tile. */
  isPopular: boolean;
  /** From `services.is_featured`. Lifts the tile (larger card + subtle glow). */
  isFeatured: boolean;
};

export type BookingComboItem = {
  id: string;
  name: string;
  description: string | null;
  /** IDs of component services, ordered. */
  serviceIds: string[];
  /** Custom bundle price (may be less than sum of components). */
  priceCents: number;
  /** Advertised savings vs. booking each service separately. */
  discountCents: number;
  /** Total blocked duration in minutes for slot calculations. */
  durationMinutes: number;
};

export function getServiceById(
  services: readonly BookingServiceItem[],
  id: string,
): BookingServiceItem | undefined {
  return services.find((s) => s.id === id);
}
