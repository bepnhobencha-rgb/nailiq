import "server-only";

import { createHash } from "node:crypto";

/**
 * Hash the complete, ordered Checkout request descriptor before reserving a
 * provider idempotency key. The ledger stores only this digest, never signer
 * details, offer tokens, or other request values.
 */
export function stripeCheckoutRequestFingerprint(
  descriptor: Readonly<Record<string, unknown>>,
): string {
  return createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
}
