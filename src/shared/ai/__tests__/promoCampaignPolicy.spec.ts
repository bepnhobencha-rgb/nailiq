import { describe, expect, it } from "vitest";

import {
  normalizePromoCampaignDraft,
  promoCampaignFallback,
  promoCampaignHasOfferFacts,
  promoCampaignPeriodKey,
  safeAiPromoCampaignMessage,
  safeOwnerPromoCampaignMessage,
} from "@/shared/ai/promoCampaignPolicy";

describe("promo campaign draft policy", () => {
  it("keeps deterministic English and Vietnamese fallbacks free of offer facts", () => {
    for (const language of ["en", "vi"] as const) {
      const fallback = promoCampaignFallback(language);
      expect(fallback.language).toBe(language);
      expect(fallback.draftMessage.length).toBeGreaterThanOrEqual(20);
      expect(promoCampaignHasOfferFacts(fallback.draftMessage)).toBe(false);
    }
  });

  it("rejects AI-invented discounts, prices, dates, contact data and guarantees", () => {
    expect(safeAiPromoCampaignMessage("Take 15% off this week at our salon.")).toBeNull();
    expect(safeAiPromoCampaignMessage("Pay $20 and call +16045550123.")).toBeNull();
    expect(safeAiPromoCampaignMessage("Guaranteed results at https://example.com")).toBeNull();
  });

  it("requires an explicit owner confirmation before saving numeric offer facts", () => {
    const message = "Owner confirmed: take 15 percent off a selected salon service.";
    expect(safeOwnerPromoCampaignMessage(message, false)).toBeNull();
    expect(safeOwnerPromoCampaignMessage(message, true)).toBe(message);
  });

  it("replaces unsafe provider text with a safe same-language fallback", () => {
    const normalized = normalizePromoCampaignDraft(
      {
        title: "Flash deal",
        reasoning: "Quiet appointment windows need attention.",
        draftMessage: "Take 30% off before 5pm.",
      },
      "en",
    );
    expect(normalized.draftMessage).toBe(promoCampaignFallback("en").draftMessage);
    expect(promoCampaignHasOfferFacts(normalized.draftMessage)).toBe(false);
  });

  it("uses a stable salon-week Monday key", () => {
    expect(promoCampaignPeriodKey("2026-08-23")).toBe("2026-08-17");
    expect(promoCampaignPeriodKey("2026-08-24")).toBe("2026-08-24");
    expect(promoCampaignPeriodKey("bad-date")).toBeNull();
  });
});
