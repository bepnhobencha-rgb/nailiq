import { describe, expect, it } from "vitest";
import { toProviderMinorAmount } from "../providerMinorUnits";

describe("toProviderMinorAmount", () => {
  it("keeps ordinary cent currencies unchanged", () => {
    expect(toProviderMinorAmount(2_500, "CAD")).toBe(2_500);
    expect(toProviderMinorAmount(2_500, "usd")).toBe(2_500);
  });

  it("preserves smallest-unit amounts for zero-decimal currencies", () => {
    expect(toProviderMinorAmount(250_000, "VND")).toBe(250_000);
    expect(toProviderMinorAmount(250_000, "JPY")).toBe(250_000);
  });

  it("fails closed on invalid money or currency", () => {
    expect(() => toProviderMinorAmount(0, "VND")).toThrow("invalid_internal_amount");
    expect(() => toProviderMinorAmount(2_501, "VN")).toThrow("invalid_currency");
  });
});
