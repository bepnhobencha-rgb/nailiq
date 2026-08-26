import { describe, expect, it } from "vitest";
import {
  groupBookingIdempotencyForIntent,
  resetGroupBookingIdempotency,
} from "@/shared/booking/groupBookingPricing";

describe("group booking idempotency lifecycle", () => {
  it("keeps one key through pricing_changed reconfirm and rotates only for a new intent or success", () => {
    const initial = { intentKey: null, key: "unused-seed" };
    const firstConfirm = groupBookingIdempotencyForIntent(initial, "intent-a", "key-a");
    expect(firstConfirm).toEqual({ intentKey: "intent-a", key: "key-a" });

    // pricing_changed has no acknowledged booking and uses the same material
    // intent, so the required second explicit click must retain key-a.
    const secondConfirm = groupBookingIdempotencyForIntent(
      firstConfirm,
      "intent-a",
      "must-not-rotate",
    );
    expect(secondConfirm).toBe(firstConfirm);

    const changedIntent = groupBookingIdempotencyForIntent(
      secondConfirm,
      "intent-b",
      "key-b",
    );
    expect(changedIntent).toEqual({ intentKey: "intent-b", key: "key-b" });

    const afterSuccess = resetGroupBookingIdempotency("success-seed");
    expect(afterSuccess).toEqual({ intentKey: null, key: "success-seed" });
    expect(
      groupBookingIdempotencyForIntent(afterSuccess, "intent-b", "key-c"),
    ).toEqual({ intentKey: "intent-b", key: "key-c" });
  });
});
