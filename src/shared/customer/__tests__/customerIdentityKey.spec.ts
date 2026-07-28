import { describe, expect, it } from "vitest";
import { customerIdentityKey } from "@/shared/customer/customerIdentityKey";

describe("customerIdentityKey", () => {
  it("prefers the canonical profile over preserved booking phones", () => {
    expect(
      customerIdentityKey({
        clientProfileId: "canonical-profile",
        clientPhone: "+1 (604) 555-0101",
      }),
    ).toBe("profile:canonical-profile");
    expect(
      customerIdentityKey({
        clientProfileId: "canonical-profile",
        clientPhone: "+1 (604) 555-0199",
      }),
    ).toBe("profile:canonical-profile");
  });

  it("normalizes phone as a legacy fallback", () => {
    expect(
      customerIdentityKey({
        clientProfileId: null,
        clientPhone: "+1 (604) 555-0101",
      }),
    ).toBe("phone:16045550101");
  });

  it("returns null when no usable identity exists", () => {
    expect(
      customerIdentityKey({ clientProfileId: " ", clientPhone: " " }),
    ).toBe(null);
  });
});
