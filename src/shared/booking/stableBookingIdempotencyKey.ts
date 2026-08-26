import "server-only";

import { createHash } from "node:crypto";

/** Deterministic UUID for a provider retry of the exact same booking intent.
 * It changes when any supplied material changes and contains no raw PII. */
export function stableBookingIdempotencyKey(material: unknown): string {
  const bytes = Buffer.from(
    createHash("sha256").update(JSON.stringify(material)).digest().subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
