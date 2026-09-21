import { describe, expect, it } from "vitest";
import { heuristicAutoMapping, sanitizeAutoMapping } from "../autoMapping";

const services = [
  { id: "gel", name: "Gel Manicure", isAddon: false },
  { id: "acrylic", name: "Acrylic Full Set", isAddon: false },
  { id: "shellac", name: "Manicure Shellac French", isAddon: false },
  { id: "chrome", name: "Chrome Add-on", isAddon: true },
  { id: "length", name: "Extra Length", isAddon: true },
];

describe("sanitizeAutoMapping", () => {
  it("drops hallucinated IDs and caps alternatives at two", () => {
    expect(sanitizeAutoMapping({
      bestServiceId: "gel",
      alternativeServiceIds: ["acrylic", "shellac", "fake", "gel"],
      addonServiceIds: ["chrome", "acrylic", "fake"],
      baseServiceKnown: true,
      visualConfidence: 1,
      serviceConfidence: 0.95,
      reason: "Exact menu match",
      attributes: ["chrome", "chrome"],
    }, services)).toMatchObject({
      serviceIds: ["gel", "acrylic", "shellac"],
      addonServiceIds: ["chrome"],
      defaultServiceId: "gel",
      attributes: ["chrome"],
      status: "ai_suggested",
    });
  });

  it("never auto-approves or exceeds 74% when the base is unknown", () => {
    expect(sanitizeAutoMapping({
      bestServiceId: "gel", alternativeServiceIds: [], addonServiceIds: [],
      baseServiceKnown: false, visualConfidence: 0.98, serviceConfidence: 0.99,
      reason: "Visible red nails", requiredQuestion: null,
    }, services)).toMatchObject({
      serviceConfidence: 0.74,
      confidence: 0.74,
      status: "needs_review",
      requiredQuestion: "Do you want this look on natural nails, or with added length?",
    });
  });

  it("does not accept a default service outside the salon menu", () => {
    expect(sanitizeAutoMapping({
      bestServiceId: "fake", alternativeServiceIds: [], addonServiceIds: [],
      baseServiceKnown: true, visualConfidence: 1, serviceConfidence: 1, reason: "bad id",
    }, services)).toMatchObject({ serviceIds: [], defaultServiceId: null, status: "needs_review" });
  });
});

describe("heuristicAutoMapping", () => {
  it("maps an explicitly named base system and visible add-ons", () => {
    expect(heuristicAutoMapping("XXL acrylic chrome nails", services)).toMatchObject({
      serviceIds: ["acrylic"], addonServiceIds: ["chrome", "length"],
      defaultServiceId: "acrylic", baseServiceKnown: true, status: "needs_review",
    });
  });

  it("abstains instead of inventing a base service for a color-only design", () => {
    expect(heuristicAutoMapping("Classic cherry glossy red", services)).toMatchObject({
      serviceIds: [], defaultServiceId: null, baseServiceKnown: false,
      serviceConfidence: 0.4, status: "needs_review",
    });
  });
});
