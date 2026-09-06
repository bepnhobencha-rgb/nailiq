export type BookingConfirmationDeliveryTruth = {
  sms: "accepted" | "suppressed" | "unverified" | "not_requested";
  email: "processing" | "not_requested";
};

type SmsConfirmationResponse = {
  ok?: unknown;
  outcome?: unknown;
};

/**
 * Convert the SMS confirmation route response into the deliberately small
 * public truth contract used by the success screen. "accepted" means the
 * provider accepted the message for delivery; it never claims handset
 * delivery. Unknown, malformed, or failed responses stay unverified.
 */
export function resolvePublicBookingSmsTruth(args: {
  requested: boolean;
  responseOk: boolean;
  body: SmsConfirmationResponse | null;
}): BookingConfirmationDeliveryTruth["sms"] {
  if (!args.requested) return "not_requested";
  if (args.body?.outcome === "suppressed") return "suppressed";
  if (
    args.responseOk &&
    args.body?.ok === true &&
    args.body.outcome === "accepted"
  ) {
    return "accepted";
  }
  return "unverified";
}
