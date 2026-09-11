import { describe, expect, it } from "vitest";

import { shouldShowCampaignDispatchStage } from "../bulkEmailCampaignPresentation";

describe("bulk email campaign presentation", () => {
  it("does not repeat the completed campaign status as a completed dispatch stage", () => {
    expect(shouldShowCampaignDispatchStage("completed", "completed")).toBe(false);
  });

  it("keeps distinct operational stages visible", () => {
    expect(shouldShowCampaignDispatchStage("approved", "locked")).toBe(true);
    expect(shouldShowCampaignDispatchStage("sending", "paused")).toBe(true);
    expect(shouldShowCampaignDispatchStage("sending", "canary_complete")).toBe(true);
  });

  it("keeps pre-dispatch cards limited to their campaign status", () => {
    expect(shouldShowCampaignDispatchStage("draft", "locked")).toBe(false);
    expect(shouldShowCampaignDispatchStage("prepared", "locked")).toBe(false);
  });
});
