/**
 * Types and helpers for the public booking service list (loaded server-side from Supabase).
 */
import type { ServiceCategory } from "@/shared/booking/serviceCategory";

export type BookingServiceItem = {
  id: string;
  name: string;
  durationMinutes: number;
  /** Operational staff/resource setup before customer work. */
  prepMinutes: number;
  bufferMinutes: number;
  /** Total length in minutes (service duration + buffer), for tiles + blocking. */
  totalMinutes: number;
  /** Snapshot from `services.price_cents`; optional display string. */
  priceCents: number | null;
  /** Variable-pricing model from `services.price_type`
   * ('fixed' | 'from' | 'range'). Drives how `priceDisplay` is rendered. */
  priceType: string;
  /** Upper bound (cents) from `services.price_max_cents` for the 'range'
   * model; `null` for fixed/from. */
  priceMaxCents: number | null;
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
  /** Add-on only: `services.addon_timing === 'concurrent'` — runs alongside the
   *  main service so it adds price but NO time to the appointment. */
  addonConcurrent: boolean;
  /** Active promotion price (null when no promo applies). Lower than priceCents. */
  promoPriceCents: number | null;
  /** Formatted promo price for display (e.g. "$90.00"). */
  promoPriceDisplay: string | null;
  /** Promotion ID driving the promo price. */
  promoId: string | null;
  /** Human-readable campaign name shown as badge on the booking page. */
  promoName: string | null;
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
