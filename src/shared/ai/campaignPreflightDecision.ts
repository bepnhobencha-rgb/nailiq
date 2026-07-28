import {
  decideAudienceEligibility,
  type AudienceEligibilityInput,
} from "@/shared/ai/audienceEligibility";
import type { CustomerChannelMode } from "@/shared/lib/channelResolver";

export type CampaignPreflightExclusion =
  | "recent_contact"
  | "no_consent"
  | "no_channel"
  | "missing_profile"
  | "manifest_channel_unavailable";

export type CampaignPreflightDecision = {
  client_profile_id: string;
  sms: boolean;
  email: boolean;
  exclusion: CampaignPreflightExclusion | null;
};

export function decideCampaignPreflight(input: {
  profile: AudienceEligibilityInput;
  manifest: { sms: boolean; email: boolean };
  salon: {
    customerChannel: CustomerChannelMode;
    smsOutboundEnabled: boolean;
    emailOutboundEnabled: boolean;
    smsA2pRegistered: boolean;
  };
}): CampaignPreflightDecision {
  const current = decideAudienceEligibility(input.profile, input.salon);
  if (!current.eligible) {
    return {
      client_profile_id: input.profile.profileId,
      sms: false,
      email: false,
      exclusion: current.reason,
    };
  }

  // The live decision may only remove approved channels. It can never expand
  // beyond the exact immutable manifest that received final approval.
  const sms = current.sms && input.manifest.sms;
  const email = current.email && input.manifest.email;
  return {
    client_profile_id: input.profile.profileId,
    sms,
    email,
    exclusion: sms || email ? null : "manifest_channel_unavailable",
  };
}
