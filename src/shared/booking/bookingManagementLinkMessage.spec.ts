import { describe, expect, it } from "vitest";
import { bookingManagementLinkMessage } from "./bookingManagementLinkMessage";

describe("management link guidance", () => {
  it("does not equate a consumed capability with a current booking outcome", () => {
    const copy = bookingManagementLinkMessage("token_consumed");
    expect(copy.title).toBe("Link already used");
    expect(copy.message).toContain("current status");
    expect(copy.message).not.toContain("appointment is cancelled");
    expect(copy.message).not.toContain("appointment is confirmed");
  });
  it.each(["stale_booking", "stale_policy", "stale_party", "expired_or_revoked", "token_invalid"])("offers a safe next step for %s", code => {
    expect(bookingManagementLinkMessage(code).message).toContain("latest appointment message");
    expect(bookingManagementLinkMessage(code).message).toContain("tiệm");
  });
  it.each(["missing_token", "invalid_token", "action_mismatch"])("does not invent a salon identity for %s", code => {
    expect(bookingManagementLinkMessage(code).message).toContain("complete link");
  });
  it("does not echo unknown server errors or claim success", () => {
    const copy = bookingManagementLinkMessage("sensitive-diagnostic");
    expect(copy.message).toContain("could not verify");
    expect(JSON.stringify(copy)).not.toContain("sensitive-diagnostic");
  });
});
