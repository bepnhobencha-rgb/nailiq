import { describe, expect, it } from "vitest";
import {
  resolvePublicBookingSmsTruth,
  shouldDispatchPublicBookingSmsConfirmation,
} from "../bookingConfirmationDeliveryTruth";

describe("public booking confirmation delivery truth", () => {
  it.each([false, null, undefined])(
    "does not cross the SMS dispatch boundary without explicit consent (%s)",
    (smsConsent) => {
      expect(shouldDispatchPublicBookingSmsConfirmation(smsConsent)).toBe(false);
    },
  );

  it("dispatches SMS only for explicit consent", () => {
    expect(shouldDispatchPublicBookingSmsConfirmation(true)).toBe(true);
  });

  it("claims provider acceptance only for an accepted successful response", () => {
    expect(resolvePublicBookingSmsTruth({
      requested: true,
      responseOk: true,
      body: { ok: true, outcome: "accepted" },
    })).toBe("accepted");
  });

  it("surfaces an operational kill-switch as suppressed", () => {
    expect(resolvePublicBookingSmsTruth({
      requested: true,
      responseOk: true,
      body: { ok: true, outcome: "suppressed" },
    })).toBe("suppressed");
  });

  it.each([
    { responseOk: false, body: { ok: false, outcome: "rejected" } },
    { responseOk: false, body: { ok: false, outcome: "unknown" } },
    { responseOk: true, body: { ok: true, outcome: "unknown" } },
    { responseOk: true, body: null },
  ])("never turns an uncertain response into a sent claim", ({ responseOk, body }) => {
    expect(resolvePublicBookingSmsTruth({
      requested: true,
      responseOk,
      body,
    })).toBe("unverified");
  });

  it("reports not requested when the customer did not opt into SMS", () => {
    expect(resolvePublicBookingSmsTruth({
      requested: false,
      responseOk: true,
      body: { ok: true, outcome: "accepted" },
    })).toBe("not_requested");
  });
});
