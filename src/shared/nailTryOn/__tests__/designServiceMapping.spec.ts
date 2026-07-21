import { describe, expect, it } from "vitest";
import { mappingMatchesServices } from "@/shared/nailTryOn/designServiceMapping";

describe("mappingMatchesServices", () => {
  const rows = [
    { id: "manicure", is_addon: false },
    { id: "chrome", is_addon: true },
  ];

  it("accepts a main service and add-on with the correct roles", () => {
    expect(mappingMatchesServices(rows, "manicure", "chrome")).toBe(true);
  });

  it("rejects swapped service roles", () => {
    expect(mappingMatchesServices(rows, "chrome", "manicure")).toBe(false);
  });

  it("rejects IDs absent from the salon-filtered result", () => {
    expect(mappingMatchesServices(rows, "other-salon-service", null)).toBe(false);
  });

  it("allows an intentionally empty mapping", () => {
    expect(mappingMatchesServices(rows, null, null)).toBe(true);
  });
});
