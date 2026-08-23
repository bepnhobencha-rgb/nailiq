import { describe, expect, it } from "vitest";
import { qaAllowedDevOrigins } from "../../../../next.config";

describe("qaAllowedDevOrigins", () => {
  it("allows only the exact explicitly configured hostname", () => {
    expect(
      qaAllowedDevOrigins("https://single-use-name.trycloudflare.com"),
    ).toEqual(["single-use-name.trycloudflare.com"]);
  });

  it.each([
    undefined,
    "",
    "javascript:alert(1)",
    "https://user:secret@example.test",
    "https://example.test/path",
    "https://example.test/?token=secret",
    "*.example.test",
  ])("rejects absent, wildcard, credentialed, or non-origin input: %s", (value) => {
    expect(qaAllowedDevOrigins(value)).toBeUndefined();
  });
});
