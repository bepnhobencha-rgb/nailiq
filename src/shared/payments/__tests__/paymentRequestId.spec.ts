import { describe, expect, it } from "vitest";

import { stableBookingPaymentRequestId } from "../paymentRequestId";

describe("stableBookingPaymentRequestId", () => {
  it("keeps exact no-show replay stable and separates operation/occurrence", () => {
    const booking = "22222222-2222-4222-8222-222222222222";
    const first = stableBookingPaymentRequestId(booking, "noshow_charge");
    expect(stableBookingPaymentRequestId(booking, "noshow_charge")).toBe(first);
    expect(stableBookingPaymentRequestId(booking, "late_cancel_charge", "7"))
      .not.toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });
});
