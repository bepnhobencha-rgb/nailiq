import { describe, expect, it } from "vitest";

import { buildActionIntelligence } from "@/shared/ai/actionIntelligence";

describe("buildActionIntelligence", () => {
  it("uses structured intelligence supplied by an agent", () => {
    const result = buildActionIntelligence(
      "bulk_message",
      {
        reason: "Seven clients have not returned in 45 days.",
        evidence: ["7 clients matched", { source: "booking history" }],
        expected_impact: "Recover 1–2 bookings.",
        confidence: 0.74,
        reversible: false,
      },
      "en",
    );

    expect(result.reason).toContain("Seven clients");
    expect(result.evidence).toEqual(["7 clients matched", "booking history"]);
    expect(result.impact).toBe("Recover 1–2 bookings.");
    expect(result.confidence).toEqual({ label: "74%", percent: 74 });
    expect(result.reversibility.reversible).toBe(false);
  });

  it("derives only verifiable impact facts from legacy payloads", () => {
    const result = buildActionIntelligence(
      "bulk_message",
      { recipients: ["a", "b", "c"] },
      "vi",
    );

    expect(result.impact).toBe("Hành động sẽ liên hệ 3 khách hàng.");
    expect(result.confidence.percent).toBeNull();
    expect(result.reason).toContain("chưa cung cấp");
    expect(result.reversibility.reversible).toBe(false);
  });

  it("normalizes percentage strings and clamps invalid ranges", () => {
    expect(
      buildActionIntelligence("price_change", { confidence: "82%" }, "en")
        .confidence.percent,
    ).toBe(82);
    expect(
      buildActionIntelligence("price_change", { confidence: 2 }, "en")
        .confidence.percent,
    ).toBe(2);
    expect(
      buildActionIntelligence("price_change", { confidence: 120 }, "en")
        .confidence.percent,
    ).toBe(100);
  });

  it("handles malformed legacy payloads without inventing evidence", () => {
    const result = buildActionIntelligence("unknown", null, "en");
    expect(result.evidence).toEqual(["No supporting evidence was attached."]);
    expect(result.impact).toContain("did not quantify");
    expect(result.reversibility.reversible).toBeNull();
  });
});
