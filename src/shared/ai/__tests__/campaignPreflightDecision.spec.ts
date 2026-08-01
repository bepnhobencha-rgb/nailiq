import { describe, expect, it } from "vitest";

import { decideCampaignPreflight } from "@/shared/ai/campaignPreflightDecision";

const profile = {
  profileId: "00000000-0000-4000-8000-000000000001",
  phone: "+16045550101",
  email: "client@example.test",
  legacySmsConsent: true,
  legacyEmailConsent: true,
  preference: null,
  recentlyContacted: false,
};

const salon = {
  customerChannel: "sms_and_email" as const,
  smsOutboundEnabled: true,
  emailOutboundEnabled: true,
  smsA2pRegistered: true,
};

describe("decideCampaignPreflight", () => {
  it("never expands beyond the approved manifest channels", () => {
    expect(
      decideCampaignPreflight({
        profile,
        manifest: { sms: true, email: false },
        salon,
      }),
    ).toEqual({
      client_profile_id: profile.profileId,
      sms: true,
      email: false,
      exclusion: null,
    });
  });

  it("blocks a recipient when consent was revoked after approval", () => {
    expect(
      decideCampaignPreflight({
        profile: {
          ...profile,
          preference: { sms: false, email: false },
        },
        manifest: { sms: true, email: true },
        salon,
      }),
    ).toEqual({
      client_profile_id: profile.profileId,
      sms: false,
      email: false,
      exclusion: "no_consent",
    });
  });

  it("blocks a recipient contacted after approval", () => {
    expect(
      decideCampaignPreflight({
        profile: { ...profile, recentlyContacted: true },
        manifest: { sms: true, email: true },
        salon,
      }).exclusion,
    ).toBe("recent_contact");
  });

  it("blocks when the only currently valid channel was not approved", () => {
    expect(
      decideCampaignPreflight({
        profile,
        manifest: { sms: true, email: false },
        salon: { ...salon, smsOutboundEnabled: false },
      }),
    ).toMatchObject({
      sms: false,
      email: false,
      exclusion: "manifest_channel_unavailable",
    });
  });
});
