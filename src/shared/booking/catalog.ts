/**
 * Public booking (`/[shop]`) service/time catalog.
 * Replace with `fetch` / server loader when per-tenant data exists.
 * Not salon-specific: same demo list for all slugs for now.
 */

export type BookingServiceItem = {
  id: string;
  name: string;
};

const DEMO_SERVICES: readonly BookingServiceItem[] = [
  { id: "manicure", name: "Classic Manicure" },
  { id: "pedicure", name: "Spa Pedicure" },
  { id: "gel", name: "Gel Full Set" },
] as const;

const DEMO_TIME_SLOTS: readonly string[] = [
  "9:00 AM",
  "10:30 AM",
  "12:00 PM",
  "2:00 PM",
  "3:30 PM",
  "5:00 PM",
] as const;

export type BookingCatalog = {
  services: readonly BookingServiceItem[];
  timeSlots: readonly string[];
};

/**
 * Resolves bookable services and time slots for a shop.
 * @param _shopSlug — reserved for future tenant lookup
 */
export function getBookingCatalog(_shopSlug: string): BookingCatalog {
  return {
    services: DEMO_SERVICES,
    timeSlots: DEMO_TIME_SLOTS,
  };
}

export function getServiceById(
  services: readonly BookingServiceItem[],
  id: string,
): BookingServiceItem | undefined {
  return services.find((s) => s.id === id);
}
