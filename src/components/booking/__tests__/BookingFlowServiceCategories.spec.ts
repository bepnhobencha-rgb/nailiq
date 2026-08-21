import { describe, expect, it } from "vitest";

import { groupServices } from "@/components/booking/BookingFlowServicePanel";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import type { ServiceCategorySummary } from "@/shared/booking/loadServiceCategories";

function service(id: string, category: string): BookingServiceItem {
  return {
    id,
    name: id,
    durationMinutes: 30,
    prepMinutes: 0,
    bufferMinutes: 0,
    totalMinutes: 30,
    priceCents: 2_000,
    priceType: "fixed",
    priceMaxCents: null,
    priceDisplay: "$20.00",
    category,
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

const categories: ServiceCategorySummary[] = [
  { slug: "manicure", nameEn: "Manicure", nameVi: "Móng tay", sortOrder: 10 },
  { slug: "pedicure", nameEn: "Pedicure", nameVi: "Móng chân", sortOrder: 20 },
  { slug: "empty", nameEn: "Empty", nameVi: "Trống", sortOrder: 30 },
  { slug: "other", nameEn: "Other", nameVi: "Khác", sortOrder: 99 },
];

describe("public booking service category grouping", () => {
  it("preserves taxonomy order and service order while omitting empty categories", () => {
    const groups = groupServices(
      [service("pedi-b", "pedicure"), service("mani-a", "manicure"), service("pedi-a", "pedicure")],
      categories,
      "en",
    );

    expect(groups.map((group) => group.category)).toEqual(["manicure", "pedicure"]);
    expect(groups.map((group) => group.label)).toEqual(["Manicure", "Pedicure"]);
    expect(groups[1]?.items.map((item) => item.id)).toEqual(["pedi-b", "pedi-a"]);
  });

  it("uses Vietnamese labels and merges active-other plus orphan rows once", () => {
    const groups = groupServices(
      [service("known", "manicure"), service("other", "other"), service("orphan", "retired")],
      categories,
      "vi",
    );

    expect(groups.map((group) => [group.category, group.label])).toEqual([
      ["manicure", "Móng tay"],
      ["other", "Khác"],
    ]);
    expect(groups[1]?.items.map((item) => item.id)).toEqual(["other", "orphan"]);
  });

  it("uses a localized fallback when no active Other taxonomy row exists", () => {
    const groups = groupServices([service("orphan", "retired")], categories.slice(0, 3), "vi");
    expect(groups).toMatchObject([
      { category: "other", label: "Khác", items: [{ id: "orphan" }] },
    ]);
  });
});
