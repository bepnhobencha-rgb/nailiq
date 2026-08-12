import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { buildPlatformAnnouncementEmail } from "@/shared/superadmin/platformAnnouncementEmail";

describe("platform announcement email copy", () => {
  it("keeps English standalone and adds human support", () => {
    const result = buildPlatformAnnouncementEmail({
      language: "en",
      subject: "A clearer front desk",
      body: "Receptionists can now find cancelled appointments faster.",
    });
    expect(result.text).toContain("Need urgent help?");
    expect(result.text).not.toContain("Cần hỗ trợ");
    expect(result.html).toContain("support@nailiq.ca");
  });

  it("keeps Vietnamese standalone and escapes untrusted copy", () => {
    const result = buildPlatformAnnouncementEmail({
      language: "vi",
      subject: "Lịch hẹn rõ ràng hơn",
      body: "<script>Không chạy</script>",
    });
    expect(result.text).toContain("Cần hỗ trợ gấp?");
    expect(result.text).not.toContain("Need urgent help?");
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
  });

  it("does not repeat support details already approved in the draft", () => {
    const result = buildPlatformAnnouncementEmail({
      language: "en",
      subject: "Help is available",
      body: "Need help? Call 778-868-0738 or email support@nailiq.ca.",
    });
    expect(result.text.match(/support@nailiq\.ca/g)).toHaveLength(1);
    expect(result.text.match(/778-868-0738/g)).toHaveLength(1);
  });
});
