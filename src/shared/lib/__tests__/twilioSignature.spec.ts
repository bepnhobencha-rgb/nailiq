import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateTwilioSignature } from "@/shared/lib/twilioSignature";

const URL = "https://www.nailiq.ca/api/twilio/status";
const TOKEN = "test_auth_token";
const PARAMS = {
  MessageSid: "SM00000000000000000000000000000001",
  MessageStatus: "delivered",
};

function sign(params: Record<string, string>): string {
  const payload =
    URL +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join("");
  return crypto.createHmac("sha1", TOKEN).update(payload).digest("base64");
}

describe("validateTwilioSignature", () => {
  it("accepts a valid Twilio signature", () => {
    expect(validateTwilioSignature(URL, PARAMS, sign(PARAMS), TOKEN)).toBe(true);
  });

  it("rejects a missing signature", () => {
    expect(validateTwilioSignature(URL, PARAMS, "", TOKEN)).toBe(false);
    expect(validateTwilioSignature(URL, PARAMS, "   ", TOKEN)).toBe(false);
  });

  it("rejects malformed and tampered signatures without throwing", () => {
    expect(validateTwilioSignature(URL, PARAMS, "short", TOKEN)).toBe(false);
    expect(
      validateTwilioSignature(
        URL,
        { ...PARAMS, MessageStatus: "failed" },
        sign(PARAMS),
        TOKEN,
      ),
    ).toBe(false);
  });
});
