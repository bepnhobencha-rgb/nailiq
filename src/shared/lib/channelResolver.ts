/**
 * Determines which channels to use when sending an automated message to a customer.
 *
 * US A2P 10DLC: until the salon completes Twilio registration, carrier filtering
 * silently drops link-bearing SMS. Use `sms_a2p_registered` to gate non-OTP SMS.
 *
 * Post-registration, admin can choose: smart (default), sms_only, email_only,
 * or sms_and_email (parallel).
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
  /** True once the salon has finished Twilio A2P 10DLC registration. */
  smsA2pRegistered: boolean;
  customerEmail: string | null;
}): ChannelDecision {
  const { mode, smsA2pRegistered, customerEmail } = opts;
  const hasEmail = !!customerEmail?.trim();
  const hasSms = smsA2pRegistered;

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
