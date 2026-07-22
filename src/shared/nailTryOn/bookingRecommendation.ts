import type { BookingServiceItem } from "@/shared/booking/catalog";

export type NailTryOnBookingIntent = {
  designName?: string;
  serviceId?: string | null;
  addonServiceId?: string | null;
  serviceIds?: string[];
  addonServiceIds?: string[];
};

export type NailTryOnBookingQuote = {
  serviceName: string;
  addOnName: string | null;
  durationMinutes: number;
  priceCents: number | null;
};

export function resolveNailTryOnBookingRecommendation(
  intent: NailTryOnBookingIntent,
  services: readonly BookingServiceItem[],
  addOns: readonly BookingServiceItem[],
) {
  const eligibleServices = (intent.serviceIds || [])
    .map((id) => services.find((item) => item.id === id))
    .filter((item): item is BookingServiceItem => Boolean(item));
  const eligibleAddOns = (intent.addonServiceIds || [])
    .map((id) => addOns.find((item) => item.id === id))
    .filter((item): item is BookingServiceItem => Boolean(item));
  const service =
    (intent.serviceId ? services.find((item) => item.id === intent.serviceId) : null) ??
    eligibleServices[0] ??
    null;
  const addOn =
    (intent.addonServiceId ? addOns.find((item) => item.id === intent.addonServiceId) : null) ??
    eligibleAddOns[0] ??
    null;
  const servicePrice = service?.promoPriceCents ?? service?.priceCents ?? null;
  const addOnPrice = addOn?.promoPriceCents ?? addOn?.priceCents ?? null;
  const quote: NailTryOnBookingQuote | null = service
    ? {
        serviceName: service.name,
        addOnName: addOn?.name ?? null,
        durationMinutes:
          service.totalMinutes + (addOn && !addOn.addonConcurrent ? addOn.totalMinutes : 0),
        priceCents: servicePrice == null ? null : servicePrice + (addOnPrice ?? 0),
      }
    : null;

  return {
    designName:
      typeof intent.designName === "string" && intent.designName.trim()
        ? intent.designName.trim()
        : null,
    service,
    addOn,
    eligibleServices,
    eligibleAddOns,
    quote,
  };
}
