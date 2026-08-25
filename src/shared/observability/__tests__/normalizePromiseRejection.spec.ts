import { describe, expect, it } from "vitest";

import { normalizePromiseRejection } from "../normalizePromiseRejection";

describe("normalizePromiseRejection", () => {
  it("preserves native Error evidence", () => {
    const reason = new Error("card verification timed out");

    expect(normalizePromiseRejection(reason)).toEqual({
      message: "card verification timed out",
      stack: reason.stack,
    });
  });

  it("extracts safe diagnostics from a cross-realm-like provider object", () => {
    expect(
      normalizePromiseRejection({
        name: "PaymentError",
        message: "Three ds method timed out while waiting for a response",
        code: "VERIFY_TIMEOUT",
        stack: "timedOut@https://web.squarecdn.com/v1/square.js:3:100",
        cardToken: "must-not-appear",
      }),
    ).toEqual({
      message: "Three ds method timed out while waiting for a response",
      stack: "timedOut@https://web.squarecdn.com/v1/square.js:3:100",
    });
  });

  it("never serializes arbitrary rejection values", () => {
    const normalized = normalizePromiseRejection({
      code: "SDK_FAILED",
      secret: "customer-token",
    });

    expect(normalized.message).toBe(
      "Unhandled promise rejection (code=SDK_FAILED)",
    );
    expect(normalized.message).not.toContain("customer-token");
  });

  it("labels null and undefined rejections", () => {
    expect(normalizePromiseRejection(null).message).toContain("null");
    expect(normalizePromiseRejection(undefined).message).toContain("undefined");
  });
});
