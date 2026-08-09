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
  });

  it("renders a standalone Vietnamese version for Vietnamese accounts", () => {
    const email = buildReleaseReviewEmail({
      reviewId: "1f6d9624-52df-48e8-8e1e-2d3aac94ba16",
      deploymentId: "abcdef1234567890",
      changeSummary: "Cải thiện thông báo cập nhật.",
      language: "vi",
    });

    expect(email.subject).toContain("Có cần thông báo");
    expect(email.html).toContain(">Có, tạo thông báo</a>");
    expect(email.html).toContain(">Không cần thông báo</a>");
    expect(email.html).toContain("Bản cập nhật đã hoạt động");
    expect(email.html).not.toContain("production");
  });

  it("escapes release text before rendering it into HTML", () => {
    const email = buildReleaseReviewEmail({
      reviewId: "1f6d9624-52df-48e8-8e1e-2d3aac94ba16",
      deploymentId: "abcdef12",
      changeSummary: '<img src=x onerror="alert(1)">',
    });
    expect(email.html).not.toContain("<img");
    expect(email.html).toContain("&lt;img");
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
