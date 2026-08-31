import { describe, expect, it } from "vitest";
import { ownerFriendlyReleaseSummary } from "@/shared/superadmin/releaseReviewPresentation";

describe("owner-friendly release presentation", () => {
  it("explains Smart Checkout without claiming that payments are live", () => {
    const raw =
      "Merge pull request #1302 from org/feat/smart-checkout\n\nfeat: Smart Checkout safe foundation and simulator";

    expect(ownerFriendlyReleaseSummary(raw, "en")).toBe(
      "NailIQ is preparing a safer checkout experience. This update does not enable live payment collection.",
    );
    expect(ownerFriendlyReleaseSummary(raw, "vi")).toBe(
      "NailIQ đang chuẩn bị trải nghiệm thanh toán an toàn hơn. Bản cập nhật này chưa bật chức năng thu tiền thật.",
    );
  });

  it("uses a business explanation for capacity rescue", () => {
    expect(
      ownerFriendlyReleaseSummary(
        "Smart Capacity Rescue for individual, sequence, and group booking",
        "vi",
      ),
    ).toContain("lưu đúng nhu cầu");
  });

  it("keeps a plain English release title but hides technical metadata", () => {
    expect(
      ownerFriendlyReleaseSummary("Improve the receptionist release flow", "en"),
    ).toBe("Improve the receptionist release flow.");
    expect(
      ownerFriendlyReleaseSummary(
        "Merge pull request #42 from org/fix/private-branch",
        "en",
      ),
    ).not.toMatch(/pull request|private-branch|#42/i);
  });
});
