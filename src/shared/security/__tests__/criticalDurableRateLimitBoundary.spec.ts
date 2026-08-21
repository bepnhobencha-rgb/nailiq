import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

describe("critical public durable rate-limit boundary", () => {
  it.each([
    "src/app/api/customer/[phone]/route.ts",
    "src/shared/contact/submitContactInquiry.ts",
  ])(
    "fails closed and hashes caller material before the provider or PII path: %s",
    (path) => {
      const text = source(path);
      const limiterIndex = text.indexOf("isOverRateLimit(");
      const privilegedWorkIndex = Math.min(
        ...[
          "createServiceRoleClient()",
          "saveNoShowCardForBooking(",
          "noShowCardDecision(",
          "getResendClient()",
        ]
          .map((marker) => text.indexOf(marker))
          .filter((index) => index >= 0),
      );

      expect(text).toContain("durableRateLimitKey(");
      expect(text).toContain('failureMode: "block"');
      expect(limiterIndex).toBeGreaterThanOrEqual(0);
      expect(privilegedWorkIndex).toBeGreaterThan(limiterIndex);
    },
  );

  it.each([
    "src/app/api/booking/square-save-card/route.ts",
    "src/app/api/booking/stripe-setup-intent/route.ts",
  ])("uses the shared fail-closed capability limiter before card provider work: %s", (path) => {
    const text = source(path);
    const limiterIndex = text.indexOf("consumeBookingManagementRateLimit(");
    const providerIndex = Math.min(
      ...["saveCardWithManagementCapability(", "createStripeSetupWithManagementCapability("]
        .map((marker) => text.indexOf(marker))
        .filter((index) => index >= 0),
    );
    expect(limiterIndex).toBeGreaterThanOrEqual(0);
    expect(text).toContain('rate !== "allowed"');
    expect(providerIndex).toBeGreaterThan(limiterIndex);
  });
});
