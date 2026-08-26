import { createHash } from "node:crypto";

import type { BookingPaymentOperationKind } from "./bookingPaymentOperations";

/** Stable UUID-shaped logical request identity. It contains no money or PII. */
export function stableBookingPaymentRequestId(
  bookingId: string,
  operationKind: BookingPaymentOperationKind,
  occurrence: string = "v1",
): string {
  const bytes = createHash("sha256")
    .update(`nailiq:booking-payment:v1:${bookingId}:${operationKind}:${occurrence}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
