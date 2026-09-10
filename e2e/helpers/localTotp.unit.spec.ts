import { describe, expect, it } from "vitest";
import { localTotp } from "./localTotp";

describe("disposable authenticator RFC 6238 SHA-1 vectors (six digits)", () => {
  // Public RFC 6238 Appendix B vector, not an account credential.
  // https://www.rfc-editor.org/rfc/rfc6238#appendix-B
  // ASCII 12345678901234567890 encoded in Base32.
  const publicRfcTestKey = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  it.each([
    [59, "287082"], [1111111109, "081804"], [1111111111, "050471"],
    [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"],
  ])("matches the reference at %i seconds", (seconds, code) => {
    expect(localTotp(publicRfcTestKey, seconds * 1000)).toBe(code);
  });
});
