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
        title: "Booking update / Cập nhật đặt hẹn",
        body: "What changed: safer booking.\n\nCó gì mới: đặt hẹn an toàn hơn.",
        severity: "info",
        target: "owners",
        notificationMode: "in_app",
        emailSubject: "NailIQ booking update",
        emailBody: "A booking workflow changed.\n\nQuy trình đặt hẹn đã thay đổi.",
        reason: "Owners need context, but no immediate action is required.",
      }),
    );
    expect(result?.notificationMode).toBe("in_app");
    expect(result?.target).toBe("owners");
  });

  it("rejects invented routing values and oversized content", () => {
    expect(
      parseReleaseConciergeDraft(
        JSON.stringify({
          title: "x",
          body: "x".repeat(2_001),
          severity: "critical",
          target: "customers",
          notificationMode: "blast",
          emailSubject: "x",
          emailBody: "x",
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
