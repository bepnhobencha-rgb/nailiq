import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildEmailExperience } from "@/shared/lib/emailExperience";
import {
  EMAIL_EXPERIENCE_REGISTRY,
  registeredEmailSourceModules,
} from "@/shared/lib/emailExperienceRegistry";

describe("unified email experience", () => {
  it("renders one mobile-safe salon shell with text, purpose tags and compliance", () => {
    const email = buildEmailExperience({
      key: "waitlist_offer",
      locale: "vi",
      subject: "Có chỗ trống",
      preheader: "Giữ chỗ trong 20 phút",
      salonName: "Hi-Lite <Spa>",
      recipientEmail: "guest@example.test",
      badge: "CHỖ TRỐNG VỪA MỞ",
      greeting: "Chào Huy,",
      heading: "Giờ bạn muốn đã sẵn sàng",
      paragraphs: ["NailIQ đã đối chiếu giờ này với lịch hiện tại của tiệm."],
      details: [{ label: "Dịch vụ", value: "Classic & Care" }],
      callout: { title: "Giữ chỗ an toàn", body: "Chưa có booking cho đến khi bạn xác nhận." },
      actions: [{ label: "Giữ chỗ", url: "https://nailiq.ca/claim?id=one" }],
      note: "Liên kết hết hạn sau 20 phút.",
    });

    expect(email.html).toContain('name="viewport"');
    expect(email.html).toContain("NAILIQ SALON CONCIERGE");
    expect(email.html).toContain("Hi-Lite &lt;Spa&gt;");
    expect(email.html).not.toContain("Classic & Care");
    expect(email.html).toContain("Classic &amp; Care");
    expect(email.html).toContain("đã yêu cầu");
    expect(email.html).toContain("Ngừng nhận email");
    expect(email.text).toContain("Dịch vụ: Classic & Care");
    expect(email.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(email.tags).toEqual([
      { name: "nailiq_email", value: "waitlist_offer" },
      { name: "nailiq_audience", value: "customer" },
    ]);
  });

  it("uses a security identity and rejects unsafe action URLs", () => {
    const email = buildEmailExperience({
      key: "booking_otp",
      locale: "en",
      subject: "Your code",
      preheader: "Code expires soon",
      salonName: "Salon",
      recipientEmail: "guest@example.test",
      badge: "ONE-TIME CODE",
      heading: "Confirm it is you",
      code: "123456",
      actions: [{ label: "Unsafe", url: "javascript:alert(1)" }],
    });

    expect(email.html).toContain("SECURE VERIFICATION");
    expect(email.html).not.toContain("javascript:");
    expect(email.html).toContain("123456");
    expect(email.text).not.toContain("Unsafe");
  });

  it("catalogs each sender with explicit audience, consent and evidence class", () => {
    expect(Object.keys(EMAIL_EXPERIENCE_REGISTRY).length).toBeGreaterThanOrEqual(20);
    expect(new Set(registeredEmailSourceModules()).size).toBe(
      registeredEmailSourceModules().length,
    );
    for (const definition of Object.values(EMAIL_EXPERIENCE_REGISTRY)) {
      expect(definition.sourceModules.length).toBeGreaterThan(0);
      expect(definition.deliveryTruth).toBeTruthy();
      expect(definition.consent).toBeTruthy();
    }
  });
});
