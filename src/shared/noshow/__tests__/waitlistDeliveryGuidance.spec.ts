import { describe, expect, it } from "vitest";
import { getWaitlistDeliveryGuidance } from "../waitlistDeliveryGuidance";
import { emptyWaitlistDeliveryTruth, type WaitlistDeliveryStatus } from "../waitlistDeliveryTruth";

const statuses: WaitlistDeliveryStatus[] = [
  "pending", "sending", "accepted", "delivered", "sent", "failed",
  "unknown", "suppressed", "unavailable",
];

describe("waitlist delivery guidance (display only)", () => {
  it.each([null, undefined, emptyWaitlistDeliveryTruth()])("fails honestly without delivery evidence: %s", (truth) => {
    expect(getWaitlistDeliveryGuidance(truth)).toBe("unverified");
  });

  for (const sms of statuses) {
    for (const email of statuses) {
      it(`${sms} / ${email}: separates delivery evidence from offer state`, () => {
        const truth = emptyWaitlistDeliveryTruth(2);
        truth.sms.status = sms;
        truth.email.status = email;
        const before = JSON.stringify(truth);
        const result = getWaitlistDeliveryGuidance(truth);
        const pair = [sms, email];
        expect(result === "delivered").toBe(pair.includes("delivered"));
        if (!pair.includes("delivered")) {
          if (pair.every((status) => ["failed", "suppressed"].includes(status))) {
            expect(result).toBe("blocked");
          } else if (pair.some((status) => ["pending", "sending"].includes(status))) {
            expect(result).toBe("pending");
          } else {
            expect(result).toBe("unverified");
          }
        }
        expect(JSON.stringify(truth)).toBe(before);
      });
    }
  }
});
