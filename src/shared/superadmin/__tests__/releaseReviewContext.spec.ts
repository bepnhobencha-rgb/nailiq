import { describe, expect, it } from "vitest";
import { currentReleaseReviewContext } from "@/shared/superadmin/releaseReviewContext";

describe("Superadmin release review context", () => {
  it("stays silent for local development builds", () => {
    expect(currentReleaseReviewContext({})).toBeNull();
  });

  it("identifies a Vercel release and carries its bounded summary", () => {
    const context = currentReleaseReviewContext({
      VERCEL_GIT_COMMIT_SHA: "abc123",
      VERCEL_GIT_COMMIT_MESSAGE: "Improve the receptionist release flow",
    });

    expect(context).toEqual({
      deploymentId: "abc123",
      changeSummary: "Improve the receptionist release flow",
    });
  });

  it("redacts private details before they cross into the client notice", () => {
    const context = currentReleaseReviewContext({
      VERCEL_GIT_COMMIT_SHA: "abc123",
      VERCEL_GIT_COMMIT_MESSAGE:
        "Fix owner@example.com with token sk_live_secret and phone 7789073426",
    });

    expect(context?.changeSummary).not.toContain("owner@example.com");
    expect(context?.changeSummary).not.toContain("sk_live_secret");
    expect(context?.changeSummary).not.toContain("7789073426");
  });

  it("uses a calm fallback when deployment metadata lacks a message", () => {
    expect(
      currentReleaseReviewContext({ VERCEL_DEPLOYMENT_ID: "deploy-1" }),
    ).toEqual({
      deploymentId: "deploy-1",
      changeSummary:
        "A new NailIQ production update is ready for communication review.",
    });
  });
});
