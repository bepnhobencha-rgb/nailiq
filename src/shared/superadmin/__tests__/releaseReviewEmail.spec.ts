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

    expect(email.html).toContain(">Prepare English &amp; Vietnamese drafts</a>");
    expect(email.html).toContain(">Do not notify salons</a>");
    expect(email.html).toContain("A NailIQ update is now active");
    expect(email.html).toContain("Notification status");
    expect(email.html).toContain("Not sent");
    expect(email.html).not.toContain("Commit abcdef12");
    expect(email.html).not.toContain("Release Review");
    expect(email.html).toContain("intent=approved");
    expect(email.html).toContain("intent=declined");
    expect(email.html).not.toContain("/api/ai/approve");
    expect(email.text).toContain("will not send anything without your final approval");
  });

  it("renders a standalone Vietnamese version for Vietnamese accounts", () => {
    const email = buildReleaseReviewEmail({
      reviewId: "1f6d9624-52df-48e8-8e1e-2d3aac94ba16",
      deploymentId: "abcdef1234567890",
      changeSummary: "Cải thiện thông báo cập nhật.",
      language: "vi",
    });

    expect(email.subject).toContain("Có cần soạn thông báo");
    expect(email.html).toContain(">Soạn bản nháp Anh &amp; Việt để tôi duyệt</a>");
    expect(email.html).toContain(">Không thông báo cho salon</a>");
    expect(email.html).toContain("Một bản cập nhật NailIQ vừa được kích hoạt");
    expect(email.html).not.toContain("production");
  });

  it("replaces pull-request metadata with plain owner language", () => {
    const email = buildReleaseReviewEmail({
      reviewId: "1f6d9624-52df-48e8-8e1e-2d3aac94ba16",
      deploymentId: "abcdef1234567890",
      changeSummary:
        "Merge pull request #1302 from bepnhobencha-rgb/feat/smart-checkout-foundation-20260831\n\nfeat: Smart Checkout safe foundation and simulator",
      language: "en",
    });

    expect(email.html).toContain("preparing a safer checkout experience");
    expect(email.html).toContain("does not enable live payment collection");
    expect(email.html).not.toContain("Merge pull request");
    expect(email.html).not.toContain("bepnhobencha-rgb");
    expect(email.text).not.toContain("#1302");
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
