import { describe, expect, it } from "vitest";

import { normalizeWalkinContact } from "../walkinContact";

describe("normalizeWalkinContact", () => {
  it("allows a walk-in to stay anonymous beyond a display name", () => {
    expect(normalizeWalkinContact({})).toEqual({
      ok: true,
      phone: null,
      email: null,
      hasContact: false,
    });
  });

  it("normalizes optional phone and email without merging by name", () => {
    expect(
      normalizeWalkinContact({
        clientPhone: "+1 (604) 555-0107",
        clientEmail: " Guest@Example.COM ",
      }),
    ).toEqual({
      ok: true,
      phone: "16045550107",
      email: "guest@example.com",
      hasContact: true,
    });
  });

  it("rejects malformed optional contact values", () => {
    expect(normalizeWalkinContact({ clientPhone: "123" })).toEqual({
      ok: false,
      error: "invalid_phone",
    });
    expect(normalizeWalkinContact({ clientEmail: "not-an-email" })).toEqual({
      ok: false,
      error: "invalid_email",
    });
  });
});
