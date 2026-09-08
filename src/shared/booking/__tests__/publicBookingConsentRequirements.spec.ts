import { describe, expect, it } from "vitest";

import { resolvePublicBookingConsentRequirements } from "@/shared/booking/publicBookingConsentRequirements";

describe("resolvePublicBookingConsentRequirements", () => {
  it("requires express SMS consent when the salon enabled outbound SMS", () => {
    expect(
      resolvePublicBookingConsentRequirements({ smsOutboundEnabled: true }),
    ).toEqual({ smsConsentRequired: true });
  });

  it.each([false, null, undefined])(
    "does not block booking when salon SMS is %s",
    (smsOutboundEnabled) => {
      expect(
        resolvePublicBookingConsentRequirements({ smsOutboundEnabled }),
      ).toEqual({ smsConsentRequired: false });
    },
  );

  it("fails closed when salon messaging readiness is unavailable", () => {
    expect(resolvePublicBookingConsentRequirements(null)).toEqual({
      smsConsentRequired: false,
    });
  });
});
