import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bookingEn } from "../../i18n/booking/en";
import { bookingVi } from "../../i18n/booking/vi";
import {
  SMS_CONSENT_VERSION,
  buildSmsConsentMeta,
  smsConsentCorpus,
  smsConsentDisclosure,
} from "../smsConsentRecord";

function reqWith(headers: Record<string, string>): Request {
  return new Request("https://nailiq.ca/api/booking/sms-confirm", { method: "POST", headers });
}

describe("smsConsentDisclosure", () => {
  it("records the exact copy the customer was shown, per language", () => {
    expect(smsConsentDisclosure("en")).toEqual({ lang: "en", text: bookingEn.smsConsent });
    expect(smsConsentDisclosure("vi")).toEqual({ lang: "vi", text: bookingVi.smsConsent });
  });

  it("falls back to Vietnamese for an absent or unknown language", () => {
    expect(smsConsentDisclosure(null).lang).toBe("vi");
    expect(smsConsentDisclosure("fr").lang).toBe("vi");
  });
});

describe("SMS_CONSENT_VERSION", () => {
  it("is derived from the disclosure copy, so it cannot drift from it", () => {
    // Edit the copy and the version moves with it — that is the point. Replace
    // it with a hand-typed constant and this fails.
    const expected = createHash("sha256").update(smsConsentCorpus()).digest("hex").slice(0, 12);
    expect(SMS_CONSENT_VERSION).toBe(expected);
  });

  it("hashes both languages verbatim, separated by a single space", () => {
    // Guards the corpus against stray bytes: an earlier revision of this file
    // shipped a NUL where the separator should be, silently changing the hash.
    expect(smsConsentCorpus()).toBe(`${bookingEn.smsConsent} ${bookingVi.smsConsent}`);
    expect(smsConsentCorpus()).not.toMatch(/\0/);
  });
});

describe("buildSmsConsentMeta", () => {
  it("takes the client IP from the first x-forwarded-for entry, not the proxy hop", () => {
    const meta = buildSmsConsentMeta(
      reqWith({ "x-forwarded-for": "203.0.113.42, 10.0.0.1", "user-agent": "iPhone" }),
      "en",
      "public_booking",
    );
    expect(meta.ip).toBe("203.0.113.42");
    expect(meta.userAgent).toBe("iPhone");
    expect(meta.text).toBe(bookingEn.smsConsent.replace("{salon}", ""));
    expect(meta.source).toBe("public_booking");
    expect(meta.groupId).toBeUndefined();
  });

  it("falls back to x-real-ip, then to 'unknown'", () => {
    expect(buildSmsConsentMeta(reqWith({ "x-real-ip": "198.51.100.7" }), "en", "public_booking").ip).toBe(
      "198.51.100.7",
    );
    const bare = buildSmsConsentMeta(reqWith({}), "en", "public_booking");
    expect(bare.ip).toBe("unknown");
    expect(bare.userAgent).toBe("unknown");
  });

  it("labels a group consent and carries the group id", () => {
    const meta = buildSmsConsentMeta(reqWith({}), "vi", "group_booking", { groupId: "g-1" });
    expect(meta.source).toBe("group_booking");
    expect(meta.groupId).toBe("g-1");
    expect(meta.lang).toBe("vi");
  });

  it("never reads consent evidence from the request body", async () => {
    // The signature only accepts a Request; a body-supplied ip/userAgent must
    // have no path into the record.
    const req = new Request("https://nailiq.ca/x", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ ip: "1.1.1.1", userAgent: "spoofed" }),
    });
    const meta = buildSmsConsentMeta(req, "en", "public_booking");
    expect(meta.ip).toBe("203.0.113.9");
    expect(meta.userAgent).toBe("unknown");
  });
});
