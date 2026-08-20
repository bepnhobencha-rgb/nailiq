import { describe, expect, it } from "vitest";

import {
  redactObservabilityContext,
  redactSensitiveText,
} from "../privacy";

describe("observability privacy redaction", () => {
  it("removes booking IDs, tokens, email addresses, and phone numbers", () => {
    const input =
      "/hilite-anaheim/wait/197f7da2-9314-4dd6-bc46-487c7a2014ec?token=secret-value customer@example.com +1 (604) 555-1212";

    const output = redactSensitiveText(input);

    expect(output).toContain("/hilite-anaheim/wait/<id>");
    expect(output).toContain("token=<redacted>");
    expect(output).toContain("<email>");
    expect(output).toContain("<phone>");
    expect(output).not.toContain("197f7da2");
    expect(output).not.toContain("secret-value");
    expect(output).not.toContain("customer@example.com");
    expect(output).not.toContain("604");
  });

  it("redacts sensitive object keys recursively before persistence", () => {
    expect(
      redactObservabilityContext({
        href: "https://nailiq.ca/shop/wait/197f7da2-9314-4dd6-bc46-487c7a2014ec",
        client_phone: "+16045551212",
        nested: { authorization: "Bearer private", safe: "booking failed" },
      }),
    ).toEqual({
      href: "https://nailiq.ca/shop/wait/<id>",
      client_phone: "<redacted>",
      nested: { authorization: "<redacted>", safe: "booking failed" },
    });
  });
});
