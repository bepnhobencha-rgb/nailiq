import { describe, expect, it } from "vitest";
import { resolveDeskEditPrice } from "../editBookingPricing";

describe("desk edit pricing truth", () => {
  it("preserves the committed discounted price for time-only edits", () => {
    expect(resolveDeskEditPrice({
      identityChanged: false,
      persistedPrice: 2300,
      catalogPrice: 2500,
    })).toBe(2300);
  });

  it("preserves a zero-dollar committed price instead of falling back", () => {
    expect(resolveDeskEditPrice({
      identityChanged: false,
      persistedPrice: 0,
      catalogPrice: 2500,
    })).toBe(0);
  });

  it("uses the current catalog price only after a service identity change", () => {
    expect(resolveDeskEditPrice({
      identityChanged: true,
      persistedPrice: 2300,
      catalogPrice: 3500,
    })).toBe(3500);
  });

  it("keeps unknown persisted pricing unknown on an unchanged edit", () => {
    expect(resolveDeskEditPrice({
      identityChanged: false,
      persistedPrice: null,
      catalogPrice: 2500,
    })).toBeNull();
  });
});
