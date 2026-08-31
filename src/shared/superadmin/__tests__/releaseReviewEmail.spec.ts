import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  buildReleaseReviewEmail,
  releaseReviewDecisionUrl,
} from "@/shared/superadmin/releaseReviewEmail";

const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

afterEach(() => {
  if (originalAppUrl === undefined) {
    delete process.env.NEXT_PUBLIC_APP_URL;
  } else {
    process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  }
});

describe("release review email", () => {
  it("uses plain English labels and links both choices to read-only pages", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://www.nailiq.ca/";
    const email = buildReleaseReviewEmail({
      reviewId: "1f6d9624-52df-48e8-8e1e-2d3aac94ba16",
      deploymentId: "abcdef1234567890",
      changeSummary: "Improve release communication.",
      language: "en",
    });

    expect(email.html).toContain(">Yes, prepare a notice</a>");
    expect(email.html).toContain(">No notice needed</a>");
    expect(email.html).toContain("The update is already active");
    expect(email.html).not.toContain("Commit abcdef12");
    expect(email.html).not.toContain("Release Review");
    expect(email.html).toContain("intent=approved");
    expect(email.html).toContain("intent=declined");
    expect(email.html).not.toContain("/api/ai/approve");
    expect(email.text).toContain("Nothing has been sent to salons");
    expect(email.subject).toContain("abcdef12");
    expect(email.html).toContain("What changed");
    expect(email.html).toContain("What salons need to do");
    expect(email.html).toContain("NailIQ recommendation");
  });

  it("renders a standalone Vietnamese version for Vietnamese accounts", () => {
    const email = buildReleaseReviewEmail({
      reviewId: "1f6d9624-52df-48e8-8e1e-2d3aac94ba16",
      deploymentId: "abcdef1234567890",
      changeSummary:
        "fix(receptionist): clarify reschedule notification times (#1204)\n\nCo-authored-by: Someone <person@example.com>",
      language: "vi",
    });

    expect(email.subject).toContain("Có cần thông báo");
    expect(email.subject).toContain("#1204");
    expect(email.html).toContain(">Có, tạo thông báo</a>");
    expect(email.html).toContain(">Không cần thông báo</a>");
    expect(email.html).toContain("Bản cập nhật đã hoạt động");
    expect(email.html).not.toContain("production");
    expect(email.html).toContain("Email đổi lịch hiển thị rõ giờ cũ và giờ mới");
    expect(email.html).toContain("Salon không cần làm gì");
    expect(email.html).not.toContain("fix(receptionist)");
    expect(email.html).not.toContain("Co-authored-by");
    expect(email.text).not.toContain("person@example.com");
  });

  it("escapes release text before rendering it into HTML", () => {
    const email = buildReleaseReviewEmail({
      reviewId: "1f6d9624-52df-48e8-8e1e-2d3aac94ba16",
      deploymentId: "abcdef12",
      changeSummary: '<img src=x onerror="alert(1)">',
    });
    expect(email.html).not.toContain("<img");
    expect(email.html).toContain("&lt;img");
    expect(email.html).toContain("&quot;alert(1)&quot;");
    expect(email.html).toContain("Manual review is required");
  });

  it("uses the canonical production URL when no override exists", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(
      releaseReviewDecisionUrl(
        "1f6d9624-52df-48e8-8e1e-2d3aac94ba16",
        "approved",
      ),
    ).toBe(
      "https://www.nailiq.ca/superadmin/operations/release-reviews/1f6d9624-52df-48e8-8e1e-2d3aac94ba16?intent=approved",
    );
  });
});
