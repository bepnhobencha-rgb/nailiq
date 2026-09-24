import type { WaitlistDeliveryTruth } from "./waitlistDeliveryTruth";

export type WaitlistDeliveryGuidance =
  | "delivered"
  | "blocked"
  | "pending"
  | "unverified";

/** Presentation only. Never use this projection to authorize or retry a send.
 * Provider acceptance (including legacy `sent`) is not delivery confirmation.
 * A delivered channel wins without hiding another channel's failure badge.
 */
export function getWaitlistDeliveryGuidance(
  delivery: WaitlistDeliveryTruth | null | undefined,
): WaitlistDeliveryGuidance {
  if (!delivery) return "unverified";
  const channels = [delivery.sms, delivery.email];
  if (channels.some((channel) => channel.status === "delivered")) {
    return "delivered";
  }
  if (channels.every((channel) =>
    channel.status === "failed" || channel.status === "suppressed",
  )) {
    return "blocked";
  }
  if (channels.some((channel) =>
    channel.status === "pending" || channel.status === "sending",
  )) {
    return "pending";
  }
  return "unverified";
}
