import { describe, expect, it } from "vitest";

import { buildSquareStoreBillingContact } from "@/shared/noshow/squareStoreBillingContact";

describe("buildSquareStoreBillingContact", () => {
  it("passes the booking identity fields Square can use for STORE verification", () => {
    expect(
      buildSquareStoreBillingContact({
        name: "  John Tran  ",
        phone: " +1 604 555 0123 ",
        email: " customer@example.com ",
      }),
    ).toEqual({
      givenName: "John",
      familyName: "Tran",
      phone: "+1 604 555 0123",
      email: "customer@example.com",
    });
  });

  it("omits empty optional fields instead of sending blank strings", () => {
    expect(
      buildSquareStoreBillingContact({ name: "Madonna", phone: " ", email: "" }),
    ).toEqual({ givenName: "Madonna" });
  });
});
