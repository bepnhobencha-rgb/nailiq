/**
 * Determines which channels to use when sending an automated message to a customer.
 *
 * `smsOutboundEnabled` (salons.sms_outbound_enabled, default TRUE) is the
 * operational gate — true for all non-US salons and US salons that have
 * completed Twilio A2P 10DLC registration. US salons waiting on A2P should
 * set it to FALSE in Admin Settings to avoid silent carrier drops.
 *
 * `sms_a2p_registered` is kept as a separate informational/compliance flag
 * but does NOT control routing here.
 */

export type CustomerChannelMode = "smart" | "sms_only" | "email_only" | "sms_and_email";

export interface ChannelDecision {
  sms: boolean;
  email: boolean;
  /** True when neither channel is available — callers should skip the send. */
  noChannel: boolean;
  /** Human-readable reason for logging. */
  reason: string;
}

export function resolveCustomerChannel(opts: {
  mode: CustomerChannelMode;
  /** Operational gate — true for non-US salons and US salons after A2P. Default true. */
  smsOutboundEnabled: boolean;
  /** When false, all outbound email is suppressed regardless of mode. Default true. */
  emailOutboundEnabled: boolean;
  customerEmail: string | null;
}): ChannelDecision {
  const { mode, smsOutboundEnabled, emailOutboundEnabled, customerEmail } = opts;
  const hasEmail = emailOutboundEnabled && !!customerEmail?.trim();
  const hasSms = smsOutboundEnabled;

  switch (mode) {
    case "sms_only":
      return {
        sms: hasSms,
        email: false,
        noChannel: !hasSms,
        reason: hasSms ? "sms_only" : "sms_only_but_a2p_not_registered",
      };

    case "email_only":
      return {
        sms: false,
        email: hasEmail,
        noChannel: !hasEmail,
        reason: hasEmail ? "email_only" : "email_only_but_no_email_on_file",
      };

    case "sms_and_email":
      return {
        sms: hasSms,
        email: hasEmail,
        noChannel: !hasSms && !hasEmail,
        reason: "sms_and_email",
      };

    case "smart":
    default:
      if (!hasSms && !hasEmail)
        return { sms: false, email: false, noChannel: true, reason: "no_channel_available" };
      if (!hasSms)
        return { sms: false, email: hasEmail, noChannel: false, reason: "email_a2p_fallback" };
      // A2P registered — use both when possible, SMS-only if no email.
      return { sms: true, email: hasEmail, noChannel: false, reason: hasEmail ? "smart_both" : "smart_sms_only" };
  }
}
