import { describe, expect, it } from "vitest";

import { classifyClientErrorDisposition } from "../clientErrorDisposition";

describe("classifyClientErrorDisposition", () => {
  it("ignores opaque cross-origin script errors", () => {
    expect(classifyClientErrorDisposition("Script error.")).toBe("ignore");
  });

  it("keeps a handled Square 3DS timeout as warning telemetry", () => {
    const stack =
      "Rf@https://web.squarecdn.com/v1/square.js:3:142820\n" +
      "timedOut@https://web.squarecdn.com/v1/square.js:3:143031";

    expect(
      classifyClientErrorDisposition(
        "Three ds method timed out while waiting for a response",
        stack,
      ),
    ).toBe("warning");
  });

  it("does not downgrade a matching message without Square SDK evidence", () => {
    expect(
      classifyClientErrorDisposition(
        "Three ds method timed out while waiting for a response",
        "at submitPayment (/app/checkout.js:1:20)",
      ),
    ).toBe("error");
  });

  it("does not downgrade other Square SDK failures", () => {
    expect(
      classifyClientErrorDisposition(
        "Unexpected payment tokenization failure",
        "at tokenize (https://web.squarecdn.com/v1/square.js:3:142820)",
      ),
    ).toBe("error");
  });
});
