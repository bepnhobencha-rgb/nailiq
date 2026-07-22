import { describe, expect, it } from "vitest";
import { heuristicAutoMapping, sanitizeAutoMapping } from "../autoMapping";

const services = [
  { id: "gel", name: "Gel Manicure", isAddon: false },
  { id: "acrylic", name: "Acrylic Full Set", isAddon: false },
  { id: "chrome", name: "Chrome Add-on", isAddon: true },
  { id: "length", name: "Extra Length", isAddon: true },
];

describe("sanitizeAutoMapping", () => {
  it("drops hallucinated and wrong-role service ids", () => {
    expect(sanitizeAutoMapping({
      serviceIds: ["gel", "chrome", "fake", "gel"],
      addonServiceIds: ["chrome", "acrylic", "fake"],
      defaultServiceId: "fake",
      confidence: 2,
      reason: "Salon menu match",
      attributes: ["chrome", "chrome"],
    }, services)).toMatchObject({
      serviceIds: ["gel"],
      addonServiceIds: ["chrome"],
      defaultServiceId: "gel",
      confidence: 1,
      attributes: ["chrome"],
      status: "ai_suggested",
    });
  });

  it("requires review when confidence is low", () => {
    expect(sanitizeAutoMapping({
      serviceIds: ["gel"], addonServiceIds: [], defaultServiceId: "gel",
      confidence: 0.5, reason: "uncertain",
    }, services).status).toBe("needs_review");
  });
});

describe("heuristicAutoMapping", () => {
  it("matches a product family and visible add-ons", () => {
    expect(heuristicAutoMapping("XXL acrylic chrome nails", services)).toMatchObject({
      serviceIds: ["acrylic"],
      addonServiceIds: ["chrome", "length"],
      defaultServiceId: "acrylic",
      status: "ai_suggested",
    });
  });

  it("falls back safely and requests review", () => {
    expect(heuristicAutoMapping("Classic cherry", services)).toMatchObject({
      serviceIds: ["gel"],
      confidence: 0.45,
      status: "needs_review",
    });
  });
});
