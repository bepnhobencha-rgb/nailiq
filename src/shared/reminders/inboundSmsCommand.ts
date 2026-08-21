export type InboundSmsCommand =
  | "consent_stop"
  | "consent_start"
  | "consent_help"
  | "booking_confirm"
  | "booking_cancel"
  | "unknown";

const PROVIDER_OPT_OUT_TYPES = new Map<string, InboundSmsCommand>([
  ["STOP", "consent_stop"],
  ["START", "consent_start"],
  ["HELP", "consent_help"],
]);

// Standard long-code opt-out vocabulary. Full-message matching is deliberate:
// Twilio only treats a complete keyword as an opt-out, not "stop please".
const STOP_WORDS = new Set([
  "stop", "stopall", "unsubscribe", "cancel", "end", "quit", "revoke", "optout",
]);
const START_WORDS = new Set(["start", "unstop"]);
const HELP_WORDS = new Set(["help", "info"]);

const CONFIRM_WORDS = new Set([
  "yes", "y", "yeah", "yep", "ya", "ok", "okay", "k", "confirm", "confirmed",
  "c", "có", "co", "xacnhan", "dongy",
]);
// "cancel" is intentionally absent: it is a standard carrier opt-out keyword.
// Customers can reply NO/HỦY for the booking command or use their signed link.
const CANCEL_BOOKING_WORDS = new Set(["no", "n", "huy", "hủy", "huỷ", "khong", "không"]);

function normalizedFullMessage(body: string): string {
  return body.trim().toLowerCase();
}

/**
 * Provider consent truth always wins over booking-language heuristics.
 * `OptOutType` means Twilio already matched/replied; the app must persist the
 * state and return empty TwiML rather than send a duplicate response.
 */
export function classifyInboundSmsCommand(
  body: string,
  optOutType?: string | null,
): InboundSmsCommand {
  const providerType = optOutType?.trim().toUpperCase() ?? "";
  if (providerType) return PROVIDER_OPT_OUT_TYPES.get(providerType) ?? "unknown";

  const full = normalizedFullMessage(body);
  if (STOP_WORDS.has(full)) return "consent_stop";
  if (START_WORDS.has(full)) return "consent_start";
  if (HELP_WORDS.has(full)) return "consent_help";

  const command = full.replace(/[.!,?]/g, "");
  if (CONFIRM_WORDS.has(command)) return "booking_confirm";
  if (CANCEL_BOOKING_WORDS.has(command)) return "booking_cancel";
  const first = command.split(/\s+/)[0] ?? "";
  if (CONFIRM_WORDS.has(first)) return "booking_confirm";
  if (CANCEL_BOOKING_WORDS.has(first)) return "booking_cancel";
  return "unknown";
}
