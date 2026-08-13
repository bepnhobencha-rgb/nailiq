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
      eligibleServices: [],
      eligibleAddOns: [],
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

  it("shows menu duration without exposing internal cleanup buffers", () => {
    const base = {
      ...service("gel-manicure"),
      durationMinutes: 45,
      bufferMinutes: 10,
      totalMinutes: 55,
      priceCents: 4500,
    };
    const addOn = {
      ...service("chrome-finish"),
      durationMinutes: 15,
      bufferMinutes: 5,
      totalMinutes: 20,
      priceCents: 1000,
    };
    const result = resolveNailTryOnBookingRecommendation(
      { serviceId: base.id, addonServiceId: addOn.id },
      [base],
      [addOn],
    );

    expect(result.quote).toMatchObject({
      durationMinutes: 60,
      priceCents: 5500,
    });
  });

  it("falls back to the first valid service and exposes every eligible option", () => {
    const manicure = service("manicure");
    const gelX = service("gel-x");
    const chrome = service("chrome");
    const art = service("art");
    const result = resolveNailTryOnBookingRecommendation(
      {
        serviceId: "stale-default",
        serviceIds: [gelX.id, manicure.id, "other-salon"],
        addonServiceIds: [chrome.id, art.id],
      },
      [manicure, gelX],
      [chrome, art],
    );

    expect(result.service?.id).toBe("gel-x");
    expect(result.addOn?.id).toBe("chrome");
    expect(result.eligibleServices.map((item) => item.id)).toEqual(["gel-x", "manicure"]);
    expect(result.eligibleAddOns.map((item) => item.id)).toEqual(["chrome", "art"]);
  });
});
