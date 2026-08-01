export type ClientErrorDisposition = "ignore" | "warning" | "error";

const SQUARE_THREE_DS_TIMEOUT =
  /^Three ds method timed out while waiting for a response$/i;
const SQUARE_WEB_SDK_SOURCE =
  /https:\/\/web\.squarecdn\.com\/v1\/square\.js(?:[?#:]|$)/i;

/**
 * Keep expected provider failures observable without escalating them as
 * unhandled NailIQ errors. Square's SDK can dispatch its handled 3DS timeout
 * through the global error channel after the booking flow has already shown
 * the customer a retry state.
 */
export function classifyClientErrorDisposition(
  message: string,
  evidence?: string | null,
): ClientErrorDisposition {
  if (message === "Script error.") return "ignore";

  if (
    SQUARE_THREE_DS_TIMEOUT.test(message.trim()) &&
    SQUARE_WEB_SDK_SOURCE.test(evidence ?? "")
  ) {
    return "warning";
  }

  return "error";
}
