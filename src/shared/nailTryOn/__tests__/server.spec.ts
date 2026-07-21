import { describe, expect, it } from "vitest";
import { createSessionCredential, hashToken, verifySessionCredential } from "../sessionCredential";

describe("try-on session credentials", () => {
  it("hashes without storing the bearer token", () => {
    const credential = createSessionCredential("session-1");
    expect(credential.tokenHash).toBe(hashToken(credential.token));
    expect(credential.tokenHash).not.toContain(credential.token);
    expect(verifySessionCredential(credential.cookieValue, "session-1", credential.tokenHash)).toBe(true);
  });

  it("rejects another session and a modified token", () => {
    const credential = createSessionCredential("session-1");
    expect(verifySessionCredential(credential.cookieValue, "session-2", credential.tokenHash)).toBe(false);
    expect(verifySessionCredential(`${credential.cookieValue}x`, "session-1", credential.tokenHash)).toBe(false);
  });
});
