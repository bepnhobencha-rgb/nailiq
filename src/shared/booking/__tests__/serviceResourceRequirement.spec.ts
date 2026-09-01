import { describe, expect, it } from "vitest";
import {
  buildServiceSetupGuidance,
  normalizeServiceResourceRequirement,
} from "@/shared/booking/serviceResourceRequirement";

describe("service resource requirement", () => {
  it("rejects specific mode without a compatible kind", () => {
    expect(
      normalizeServiceResourceRequirement({ mode: "specific", kinds: [] }),
    ).toBeNull();
  });

  it("deduplicates and rejects unknown kinds", () => {
    expect(
      normalizeServiceResourceRequirement({
        mode: "specific",
        kinds: ["chair", "chair", "spaceship"],
      }),
    ).toEqual({ mode: "specific", kinds: ["chair"] });
  });

  it("uses salon-owned comparables and warns without changing price", () => {
    const guidance = buildServiceSetupGuidance({
      serviceId: "current",
      category: "pedicure",
      currentPriceCents: 1000,
      availableResourceKinds: ["chair", "bed"],
      peers: [
        {
          id: "peer-a",
          category: "pedicure",
          price_cents: 5000,
          duration_minutes: 60,
          prep_minutes: 5,
          buffer_minutes: 10,
        },
        {
          id: "peer-b",
          category: "pedicure",
          price_cents: 6000,
          duration_minutes: 75,
          prep_minutes: 10,
          buffer_minutes: 15,
        },
      ],
    });

    expect(guidance).toMatchObject({
      basis: "salon_menu",
      durationMinutes: 68,
      prepMinutes: 8,
      bufferMinutes: 13,
      priceAnchorCents: 5500,
      priceWarning: "unusually_low",
      suggestedResourceKinds: ["chair"],
    });
  });
});
