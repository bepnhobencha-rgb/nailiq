import { describe, expect, it } from "vitest";
import { selectReadinessServices } from "@/shared/dashboard/readinessServiceSelection";

const main = {
  id: "main-service",
  priceCents: 4500,
  durationMinutes: 45,
  isAddon: false,
};
const addon = {
  id: "addon-service",
  priceCents: 1000,
  durationMinutes: 10,
  isAddon: true,
};

describe("readiness service selection", () => {
  it("preserves all non-deleted services for legacy flag-off salons", () => {
    expect(selectReadinessServices([main, addon], false)).toEqual([
      { id: "main-service", priceCents: 4500, durationMinutes: 45 },
      { id: "addon-service", priceCents: 1000, durationMinutes: 10 },
    ]);
  });

  it("uses only main bookable services for the Guided QA pilot", () => {
    expect(selectReadinessServices([main, addon], true)).toEqual([
      { id: "main-service", priceCents: 4500, durationMinutes: 45 },
    ]);
  });
});
