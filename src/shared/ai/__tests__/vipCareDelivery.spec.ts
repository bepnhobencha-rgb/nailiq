import { describe, expect, it } from "vitest";
import { applyVipEmailSuppression } from "@/shared/ai/vipCareDelivery";

describe("VIP Care email suppression", () => {
  it("fails closed when email is the only delivery channel", () => {
    expect(
      applyVipEmailSuppression(
        { sms: false, email: true, noChannel: false, reason: "email_only" },
        true,
      ),
    ).toEqual({
      sms: false,
      email: false,
      noChannel: true,
      reason: "email_suppressed",
    });
  });

  it("preserves an independently permitted SMS channel", () => {
    expect(
      applyVipEmailSuppression(
        { sms: true, email: true, noChannel: false, reason: "smart_both" },
        true,
      ),
    ).toEqual({
      sms: true,
      email: false,
      noChannel: false,
      reason: "smart_both_email_suppressed",
    });
  });

  it("does not alter an unsuppressed decision", () => {
    const decision = {
      sms: false,
      email: true,
      noChannel: false,
      reason: "email_only",
    };
    expect(applyVipEmailSuppression(decision, false)).toBe(decision);
  });
});
