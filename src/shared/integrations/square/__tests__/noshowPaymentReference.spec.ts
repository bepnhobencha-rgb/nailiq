import { describe, expect, it } from "vitest";
import { noShowPaymentReferenceId } from "../noshowPaymentReference";

describe("noShowPaymentReferenceId", () => {
  it("uses the stable booking UUID within Square's 40-character limit", () => {
    const bookingId = "123e4567-e89b-12d3-a456-426614174000";
    const reference = noShowPaymentReferenceId(bookingId);

    expect(reference).toBe(bookingId);
    expect(reference.length).toBeLessThanOrEqual(40);
  });

  it("fails closed to Square's maximum for unexpected legacy identifiers", () => {
    expect(noShowPaymentReferenceId(`  ${"x".repeat(60)}  `)).toHaveLength(40);
  });
});
