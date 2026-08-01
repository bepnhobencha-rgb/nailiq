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
});
