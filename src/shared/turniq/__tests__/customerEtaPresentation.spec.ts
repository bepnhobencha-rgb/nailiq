import { describe, expect, it } from "vitest";

import { presentTurnIqCustomerEta } from "@/shared/turniq/customerEtaPresentation";

const ETA = {
  version: 1 as const,
  evaluatedAt: "2026-09-02T17:00:00.000Z",
  refreshBy: "2026-09-02T17:05:00.000Z",
  surface: "waiting" as const,
  stale: false,
  waitRange: { earliestMinutes: 10, latestMinutes: 20 },
  partyFullyStartedRange: { earliestMinutes: 25, latestMinutes: 35 },
  reasonCodes: ["ETA_FRESH_PLAN"] as const,
  message: { en: "Estimated start in 10–20 minutes.", vi: "Dự kiến 10–20 phút." },
};

describe("TurnIQ M4K customer ETA presentation", () => {
  it("shows a non-exact customer and whole-party range", () => {
    expect(presentTurnIqCustomerEta(
      ETA,
      Date.parse("2026-09-02T17:03:00.000Z"),
      false,
    )).toEqual({
      headline: "Your estimated wait",
      detail: "Estimated start in 10–20 minutes.",
      waitLabel: "10–20 min",
      partyLabel: "Everyone expected to start within 25–35 min",
      limitedConnection: false,
    });
  });

  it("hides an expired range instead of presenting stale precision", () => {
    const result = presentTurnIqCustomerEta(
      ETA,
      Date.parse("2026-09-02T17:05:00.001Z"),
      true,
    );
    expect(result.waitLabel).toBeNull();
    expect(result.partyLabel).toBeNull();
    expect(result.headline).toBe("Updating your wait");
    expect(result.limitedConnection).toBe(true);
  });
});
