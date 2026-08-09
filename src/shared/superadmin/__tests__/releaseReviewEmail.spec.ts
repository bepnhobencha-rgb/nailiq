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
  it("links both choices to authenticated read-only review pages", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://www.nailiq.ca/";
    const email = buildReleaseReviewEmail({
      reviewId: "1f6d9624-52df-48e8-8e1e-2d3aac94ba16",
      deploymentId: "abcdef1234567890",
      changeSummary: "Improve release communication.",
    });

    expect(email.html).toContain(">Duyệt</a>");
    expect(email.html).toContain(">Từ chối</a>");
    expect(email.html).toContain("intent=approved");
    expect(email.html).toContain("intent=declined");
    expect(email.html).not.toContain("/api/ai/approve");
    expect(email.text.toLowerCase()).toContain("chưa làm thay đổi dữ liệu");
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
