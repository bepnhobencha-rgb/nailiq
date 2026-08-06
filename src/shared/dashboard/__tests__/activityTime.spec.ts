import { describe, expect, it } from "vitest";

import { activityTimeAgo } from "@/shared/dashboard/activityTime";

describe("activityTimeAgo", () => {
  const now = Date.parse("2026-08-05T22:00:00.000Z");

  it("uses the caller-owned clock snapshot for relative labels", () => {
    expect(activityTimeAgo("2026-08-05T21:59:30.000Z", now, "America/Los_Angeles")).toBe(
      "vừa xong",
    );
    expect(activityTimeAgo("2026-08-05T21:58:00.000Z", now, "America/Los_Angeles")).toBe(
      "2 phút trước",
    );
    expect(activityTimeAgo("2026-08-05T19:00:00.000Z", now, "America/Los_Angeles")).toBe(
      "3 giờ trước",
    );
  });

  it("formats older activity in the salon timezone deterministically", () => {
    expect(activityTimeAgo("2026-07-29T06:30:00.000Z", now, "America/Los_Angeles")).toBe(
      "28/07/2026",
    );
  });

  it("does not expose invalid timestamps", () => {
    expect(activityTimeAgo("not-an-iso", now, "America/Los_Angeles")).toBe("");
  });
});
