import { describe, expect, it } from "vitest";

import { decideAudienceEligibility } from "@/shared/ai/audienceEligibility";

const salon = {
  customerChannel: "smart" as const,
  smsOutboundEnabled: true,
  emailOutboundEnabled: true,
  smsA2pRegistered: true,
};

const base = {
  profileId: "profile-1",
  phone: "+12025550123",
  email: "guest@example.com",
  legacySmsConsent: true,
  legacyEmailConsent: true,
  preference: null,
  recentlyContacted: false,
};

describe("decideAudienceEligibility", () => {
  it("excludes anyone contacted in the last 24 hours", () => {
    expect(
      decideAudienceEligibility({ ...base, recentlyContacted: true }, salon),
    ).toEqual({ eligible: false, reason: "recent_contact" });
  });

  it("treats structured consent as the latest explicit instruction", () => {
    expect(
      decideAudienceEligibility(
        { ...base, preference: { sms: false, email: false } },
        salon,
      ),
    ).toEqual({ eligible: false, reason: "no_consent" });
  });

  it("routes a US customer to consented email when A2P is unavailable", () => {
    expect(
      decideAudienceEligibility(
        {
          ...base,
          preference: { sms: true, email: true },
        },
        { ...salon, smsA2pRegistered: false },
      ),
    ).toEqual({ eligible: true, sms: false, email: true });
  });

  it("blocks a US SMS-only customer when A2P is unavailable", () => {
    expect(
      decideAudienceEligibility(
        {
          ...base,
          email: null,
          legacyEmailConsent: false,
          preference: { sms: true, email: false },
        },
        { ...salon, smsA2pRegistered: false },
      ),
    ).toEqual({ eligible: false, reason: "no_channel" });
  });

  it("never enables a channel without marketing consent", () => {
    expect(
      decideAudienceEligibility(
        {
          ...base,
          preference: { sms: false, email: true },
        },
        salon,
      ),
    ).toEqual({ eligible: true, sms: false, email: true });
  });
});
