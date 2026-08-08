import type { ChannelDecision } from "@/shared/lib/channelResolver";

/**
 * Remove email from a VIP Care delivery decision after a fail-closed
 * suppression check. SMS remains available when independently permitted.
 */
export function applyVipEmailSuppression(
  decision: ChannelDecision,
  suppressed: boolean,
): ChannelDecision {
  if (!suppressed || !decision.email) return decision;

  if (decision.sms) {
    return {
      ...decision,
      email: false,
      noChannel: false,
      reason: `${decision.reason}_email_suppressed`,
    };
  }

  return {
    sms: false,
    email: false,
    noChannel: true,
    reason: "email_suppressed",
  };
}
