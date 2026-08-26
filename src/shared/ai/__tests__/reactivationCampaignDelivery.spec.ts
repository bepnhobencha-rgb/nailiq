import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  REACTIVATION_CAMPAIGN_DELIVERY_HARD_OFF,
  runReactivationCampaignDelivery,
} from "@/shared/ai/reactivationCampaignDelivery";

describe("MQA-0181 reactivation campaign delivery hard-off runtime", () => {
  it("returns before any database or provider construction", async () => {
    expect(REACTIVATION_CAMPAIGN_DELIVERY_HARD_OFF).toBe(true);
    await expect(runReactivationCampaignDelivery()).resolves.toEqual({
      ok: false,
      error: "reactivation_campaign_delivery_disabled",
      providerCalled: false,
      databaseCalled: false,
    });
  });
});
