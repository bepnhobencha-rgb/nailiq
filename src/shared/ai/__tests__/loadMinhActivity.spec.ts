import { describe, expect, it } from "vitest";

import { deriveOutcomeMeasurement } from "@/shared/ai/outcomeMeasurement";

describe("deriveOutcomeMeasurement", () => {
  it("excludes pending actions from the observed return-rate denominator", () => {
    expect(
      deriveOutcomeMeasurement([
        "converted",
        "no_conversion",
        null,
        null,
      ]),
    ).toEqual({
      sent: 4,
      measured: 2,
      pending: 2,
      converted: 1,
      noConversion: 1,
      observedReturnPct: 50,
      coveragePct: 50,
    });
  });

  it("does not report a return rate before any measurement window concludes", () => {
    expect(deriveOutcomeMeasurement([null, null])).toEqual({
      sent: 2,
      measured: 0,
      pending: 2,
      converted: 0,
      noConversion: 0,
      observedReturnPct: null,
      coveragePct: 0,
    });
  });

  it("handles an empty activity window without inventing effectiveness", () => {
    expect(deriveOutcomeMeasurement([])).toEqual({
      sent: 0,
      measured: 0,
      pending: 0,
      converted: 0,
      noConversion: 0,
      observedReturnPct: null,
      coveragePct: 0,
    });
  });
});
