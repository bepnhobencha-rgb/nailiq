import { isUsPhone } from "@/shared/lib/phoneRegion";

/**
 * Determines which channels to use when sending an automated message to a customer.
 *
 * `smsOutboundEnabled` (salons.sms_outbound_enabled, default TRUE) is the manual
 * operational gate.
 *
 * A2P 10DLC guardrail (lesson #1 — see docs/decisions.md 2026-06-19): a US
 * destination number whose salon has NOT completed A2P registration
 * (`sms_a2p_registered = false`) is auto-routed to EMAIL regardless of the
 * manual flag. This stops the system from silently carrier-dropping US SMS (and
 * incurring Twilio fees) without anyone remembering to flip `sms_outbound_enabled`.
 * Non-US numbers and A2P-registered salons are unaffected. The params are
 * optional and default to the pre-guardrail behaviour, so existing callers that
 * don't pass them are unchanged.
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
  /** A2P 10DLC registration status. Default true (back-compat). */
  smsA2pRegistered?: boolean;
  /** Destination phone — used to detect US numbers that require A2P. Optional. */
  customerPhone?: string | null;
}): ChannelDecision {
  const { mode, smsOutboundEnabled, emailOutboundEnabled, customerEmail } = opts;
  const hasEmail = emailOutboundEnabled && !!customerEmail?.trim();
  // US + not-yet-A2P-registered → SMS is unsafe (carrier-dropped + billable).
  // Defaults preserve old behaviour: undefined a2p flag is treated as registered.
  const a2pBlocksUs =
    opts.smsA2pRegistered === false && isUsPhone(opts.customerPhone);
  const hasSms = smsOutboundEnabled && !a2pBlocksUs;

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
