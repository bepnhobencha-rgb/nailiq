import { describe, expect, it } from "vitest";
import { mappingMatchesServices } from "@/shared/nailTryOn/designServiceMapping";

describe("mappingMatchesServices", () => {
  const rows = [
    { id: "manicure", is_addon: false },
    { id: "chrome", is_addon: true },
  ];

  it("accepts a main service and add-on with the correct roles", () => {
    expect(mappingMatchesServices(rows, {
      serviceIds: ["manicure"],
      addonServiceIds: ["chrome"],
      defaultServiceId: "manicure",
    })).toBe(true);
  });

  it("rejects swapped service roles", () => {
    expect(mappingMatchesServices(rows, {
      serviceIds: ["chrome"],
      addonServiceIds: ["manicure"],
      defaultServiceId: "chrome",
    })).toBe(false);
  });

  it("rejects IDs absent from the salon-filtered result", () => {
    expect(mappingMatchesServices(rows, {
      serviceIds: ["other-salon-service"],
      addonServiceIds: [],
      defaultServiceId: "other-salon-service",
    })).toBe(false);
  });

  it("allows an intentionally empty mapping", () => {
    expect(mappingMatchesServices(rows, {
      serviceIds: [], addonServiceIds: [], defaultServiceId: null,
    })).toBe(true);
  });

  it("rejects duplicate IDs and a default outside the selected services", () => {
    expect(mappingMatchesServices(rows, {
      serviceIds: ["manicure", "manicure"], addonServiceIds: [], defaultServiceId: "manicure",
    })).toBe(false);
    expect(mappingMatchesServices(rows, {
      serviceIds: [], addonServiceIds: ["chrome"], defaultServiceId: "manicure",
    })).toBe(false);
  });
});
