import { describe, expect, it } from "vitest";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import { resolveNailTryOnBookingRecommendation } from "@/shared/nailTryOn/bookingRecommendation";

function service(id: string): BookingServiceItem {
  return {
    id,
    name: id,
    durationMinutes: 60,
    bufferMinutes: 0,
    totalMinutes: 60,
    priceCents: 5000,
    priceType: "fixed",
    priceMaxCents: null,
    priceDisplay: "$50.00",
    category: "other",
    description: null,
    isPopular: false,
    isFeatured: false,
    addonConcurrent: false,
    promoPriceCents: null,
    promoPriceDisplay: null,
    promoId: null,
    promoName: null,
  };
}

describe("resolveNailTryOnBookingRecommendation", () => {
  it("resolves only service IDs present in the salon catalog", () => {
    const base = service("gel-x");
    const chrome = service("chrome");
    const result = resolveNailTryOnBookingRecommendation(
      { designName: " Classic Cherry ", serviceId: base.id, addonServiceId: chrome.id },
      [base],
      [chrome],
    );

    expect(result).toEqual({
      designName: "Classic Cherry",
      service: base,
      addOn: chrome,
      quote: {
        serviceName: "gel-x",
        addOnName: "chrome",
        durationMinutes: 120,
        priceCents: 10000,
      },
    });
  });

  it("does not trust stale or cross-catalog IDs", () => {
    const result = resolveNailTryOnBookingRecommendation(
      { designName: "Look", serviceId: "other-salon", addonServiceId: "deleted-addon" },
      [service("manicure")],
      [service("french")],
    );

    expect(result.service).toBeNull();
    expect(result.addOn).toBeNull();
    expect(result.quote).toBeNull();
  });

  it("adds price but not duration for a concurrent add-on", () => {
    const base = service("manicure");
    const addOn = { ...service("quick-finish"), addonConcurrent: true };
    const result = resolveNailTryOnBookingRecommendation(
      { serviceId: base.id, addonServiceId: addOn.id },
      [base],
      [addOn],
    );

    expect(result.quote).toMatchObject({ durationMinutes: 60, priceCents: 10000 });
  });
});
