import { describe, expect, it } from "vitest";
import { createTrialWindow, trialDaysRemaining } from "@/shared/lib/trial";

describe("self-service trial", () => {
  it("creates an exact 14-day server-authored window", () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    expect(createTrialWindow(now)).toEqual({
      trialStartedAt: "2026-07-21T12:00:00.000Z",
      trialEndsAt: "2026-08-04T12:00:00.000Z",
    });
  });

  it("rounds partial days up for the owner banner", () => {
    expect(
      trialDaysRemaining(
        "2026-07-23T11:59:59.000Z",
        new Date("2026-07-21T12:00:00.000Z"),
      ),
    ).toBe(2);
  });

  it("returns zero after expiry and null for invalid values", () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    expect(trialDaysRemaining("2026-07-20T12:00:00.000Z", now)).toBe(0);
    expect(trialDaysRemaining("invalid", now)).toBeNull();
    expect(trialDaysRemaining(null, now)).toBeNull();
  });
});
