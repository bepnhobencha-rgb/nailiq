import { describe, expect, it } from "vitest";
import {
  fallbackReleaseConciergeDraft,
  parseReleaseConciergeDraft,
  redactReleaseInput,
} from "@/shared/superadmin/releaseConcierge";

describe("AI Release Concierge draft boundary", () => {
  it("accepts a valid bounded routing draft", () => {
    const result = parseReleaseConciergeDraft(
      JSON.stringify({
        localized: {
          en: {
            title: "Booking update",
            body: "What changed: safer booking.",
            emailSubject: "NailIQ booking update",
            emailBody: "A booking workflow changed.",
          },
          vi: {
            title: "Cập nhật đặt hẹn",
            body: "Có gì mới: đặt hẹn an toàn hơn.",
            emailSubject: "NailIQ cập nhật đặt hẹn",
            emailBody: "Quy trình đặt hẹn đã thay đổi.",
          },
        },
        severity: "info",
        target: "owners",
        audienceRoles: ["owner", "admin"],
        notificationMode: "in_app",
        reason: "Owners need context, but no immediate action is required.",
      }),
    );
    expect(result?.notificationMode).toBe("in_app");
    expect(result?.target).toBe("owners");
    expect(result?.audienceRoles).toEqual(["owner", "admin"]);
  });

  it("rejects invented routing values and oversized content", () => {
    expect(
      parseReleaseConciergeDraft(
        JSON.stringify({
          localized: {
            en: {
              title: "x",
              body: "x".repeat(2_001),
              emailSubject: "x",
              emailBody: "x",
            },
            vi: {
              title: "x",
              body: "x",
              emailSubject: "x",
              emailBody: "x",
            },
          },
          severity: "critical",
          target: "customers",
          audienceRoles: ["customer"],
          notificationMode: "blast",
          reason: "x",
        }),
      ),
    ).toBeNull();
  });

  it("falls back to an in-app owner draft without authorizing email", () => {
    const result = fallbackReleaseConciergeDraft(
      "A small visible settings improvement was released.",
    );
    expect(result.notificationMode).toBe("in_app");
    expect(result.target).toBe("owners");
    expect(result.audienceRoles).toEqual(["owner", "admin"]);
    expect(result.localized.en.body).not.toContain("released");
    expect(result.localized.en.body).not.toContain("Có gì mới");
    expect(result.localized.vi.body).not.toContain("What's new");
    expect(result.localized.en.emailBody).toContain("778-868-0738");
    expect(result.localized.vi.emailBody).toContain("support@nailiq.ca");
    expect(result.reason).toContain("no email is sent");
  });

  it("redacts contact details, tokens, and internal identifiers before AI", () => {
    const result = redactReleaseInput(
      "Email owner@example.com, phone 7789073426, token sk_live_secret, salon d06ca42b-d9db-4d02-9d4c-716a1e8c94be.",
    );
    expect(result).not.toContain("owner@example.com");
    expect(result).not.toContain("7789073426");
    expect(result).not.toContain("sk_live_secret");
    expect(result).not.toContain("d06ca42b-d9db-4d02-9d4c-716a1e8c94be");
  });
});
