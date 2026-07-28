import { describe, expect, it } from "vitest";

import { campaignPreflightFreshness } from "@/shared/ai/campaignPreflightFreshness";

describe("campaignPreflightFreshness", () => {
  it("treats only a future deadline as fresh", () => {
    expect(
      campaignPreflightFreshness(
        "2026-07-28T10:05:00.000Z",
        "2026-07-28T10:00:00.000Z",
      ),
    ).toBe("fresh");
    expect(
      campaignPreflightFreshness(
        "2026-07-28T10:00:00.000Z",
        "2026-07-28T10:00:00.000Z",
      ),
    ).toBe("expired");
  });

  it("fails closed on malformed timestamps", () => {
    expect(
      campaignPreflightFreshness("not-a-date", "2026-07-28T10:00:00.000Z"),
    ).toBe("invalid");
  });
});
