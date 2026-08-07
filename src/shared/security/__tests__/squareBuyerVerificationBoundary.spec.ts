import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CAPTURE_FILES = [
  "src/components/booking/ConfirmStepCardCapture.tsx",
  "src/components/booking/NoShowCardCapture.tsx",
];

describe("Square card-on-file buyer verification boundary", () => {
  for (const path of CAPTURE_FILES) {
    it(`${path} verifies during tokenization and never downgrades`, () => {
      const source = readFileSync(path, "utf8");

      expect(source).toContain('intent: "STORE"');
      expect(source).toContain("customerInitiated: true");
      expect(source).toContain("sellerKeyedIn: false");
      expect(source).not.toContain("verifyBuyer(");
      expect(source).not.toContain("verificationToken = undefined");
      expect(source).not.toMatch(/DEGRADE|downgrade to an unverified source token/i);
    });
  }

  it("includes the booking identity in pre-booking STORE verification", () => {
    const capture = readFileSync(
      "src/components/booking/ConfirmStepCardCapture.tsx",
      "utf8",
    );
    const individual = readFileSync(
      "src/components/booking/BookingFlowConfirmPanel.tsx",
      "utf8",
    );
    const group = readFileSync(
      "src/components/booking/BookingGroupFlow.tsx",
      "utf8",
    );

    expect(capture).toContain("billingContact: buildSquareStoreBillingContact");
    expect(capture).toContain("name: customerName");
    expect(capture).toContain("phone: customerPhone");
    expect(capture).toContain("email: customerEmail");

    for (const source of [individual, group]) {
      expect(source).toContain("customerName=");
      expect(source).toContain("customerPhone=");
      expect(source).toContain("customerEmail=");
    }
  });
});
