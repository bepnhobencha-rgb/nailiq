import {
  resolveCustomerChannel,
  type CustomerChannelMode,
} from "@/shared/lib/channelResolver";

export type AudienceEligibilityInput = {
  profileId: string;
  phone: string;
  email: string | null;
  legacySmsConsent: boolean;
  legacyEmailConsent: boolean;
  preference:
    | {
        sms: boolean;
        email: boolean;
      }
    | null;
  recentlyContacted: boolean;
};

export type AudienceEligibilityDecision =
  | { eligible: false; reason: "recent_contact" | "no_consent" | "no_channel" }
  | { eligible: true; sms: boolean; email: boolean };

export function decideAudienceEligibility(
  input: AudienceEligibilityInput,
  salon: {
    customerChannel: CustomerChannelMode;
    smsOutboundEnabled: boolean;
    emailOutboundEnabled: boolean;
    smsA2pRegistered: boolean;
  },
): AudienceEligibilityDecision {
  if (input.recentlyContacted) {
    return { eligible: false, reason: "recent_contact" };
  }

  // A structured preference is treated as the latest explicit instruction.
  // Legacy profile timestamps remain the fallback for older customers.
  const smsConsent = input.preference?.sms ?? input.legacySmsConsent;
  const emailConsent = input.preference?.email ?? input.legacyEmailConsent;
  if (!smsConsent && !emailConsent) {
    return { eligible: false, reason: "no_consent" };
  }

  const channel = resolveCustomerChannel({
    mode: salon.customerChannel,
    smsOutboundEnabled: salon.smsOutboundEnabled && smsConsent,
    emailOutboundEnabled: salon.emailOutboundEnabled && emailConsent,
    customerEmail: input.email,
    smsA2pRegistered: salon.smsA2pRegistered,
    customerPhone: input.phone,
  });
  if (channel.noChannel) {
    return { eligible: false, reason: "no_channel" };
  }
  return { eligible: true, sms: channel.sms, email: channel.email };
}
