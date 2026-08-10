import { describe, expect, it } from "vitest";
import {
  isReleaseReviewDecisionPath,
  presentReleaseReview,
} from "@/shared/superadmin/releaseReviewPresentation";

describe("release review presentation", () => {
  it("turns the reschedule fix into a Vietnamese business summary", () => {
    const presentation = presentReleaseReview({
      deploymentId: "02b935f3acf99e27129a1cbc8bf997fd196b9c58",
      changeSummary:
        "fix(receptionist): clarify reschedule notification times (#1204)\n\n* test: add regression\n\nCo-authored-by: Someone <person@example.com>",
      language: "vi",
    });

    expect(presentation.releaseLabel).toBe("#1204");
    expect(presentation.changeTitle).toBe(
      "Email đổi lịch hiển thị rõ giờ cũ và giờ mới",
    );
    expect(presentation.salonAction).toBe("Salon không cần làm gì.");
    expect(presentation.recommendation).toContain("Không cần gửi thông báo");
    expect(JSON.stringify(presentation)).not.toContain("Co-authored-by");
    expect(JSON.stringify(presentation)).not.toContain("person@example.com");
  });

  it("explains localized release notices without technical commit syntax", () => {
    const presentation = presentReleaseReview({
      deploymentId: "abc123",
      changeSummary:
        "feat(notifications): localize release notices per Owner/Admin account (#1203)",
      language: "vi",
    });

    expect(presentation.releaseLabel).toBe("#1203");
    expect(presentation.changeTitle).toBe(
      "Thông báo cập nhật dùng ngôn ngữ đã chọn của từng Owner/Admin",
    );
    expect(presentation.changeTitle).not.toContain("feat(");
  });

  it("uses a unique short deployment label when a PR number is unavailable", () => {
    const presentation = presentReleaseReview({
      deploymentId: "deploy-abcdef123456",
      changeSummary: "Improve release communication",
      language: "en",
    });

    expect(presentation.releaseLabel).toBe("deployab");
    expect(presentation.recommendation).toContain("Manual review");
  });

  it("describes this release-review improvement clearly in Vietnamese", () => {
    const presentation = presentReleaseReview({
      deploymentId: "abc123",
      changeSummary:
        "fix(superadmin): clarify and separate release review emails (#1205)",
      language: "vi",
    });

    expect(presentation.changeTitle).toBe(
      "Email duyệt cập nhật hiển thị nội dung dễ hiểu và tách riêng từng bản",
    );
  });

  it("recognizes decision pages where the global release banner must be hidden", () => {
    expect(
      isReleaseReviewDecisionPath(
        "/superadmin/operations/release-reviews/review-123",
      ),
    ).toBe(true);
    expect(
      isReleaseReviewDecisionPath("/superadmin/operations/announcements"),
    ).toBe(false);
  });
});
