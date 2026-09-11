import { describe, expect, it } from "vitest";

import {
  bulkEmailCampaignMetrics,
  emptyBulkEmailRecipientCounts,
  type BulkEmailCampaignReport,
} from "../bulkEmailCampaignReport";

function report(
  counts: Partial<BulkEmailCampaignReport["counts"]>,
): BulkEmailCampaignReport {
  return {
    available: true,
    audienceCount: 100,
    counts: { ...emptyBulkEmailRecipientCounts(), ...counts },
    globalSuppressionCount: 0,
    deliveryReceiptCount: 0,
    lastDeliveryEventAt: null,
    generatedAt: "2026-09-11T20:00:00.000Z",
  };
}

describe("bulk email owner report metrics", () => {
  it("separates delivered truth from provider-accepted messages still awaiting receipts", () => {
    const metrics = bulkEmailCampaignMetrics(report({ delivered: 94, providerAccepted: 3, bounced: 3 }));

    expect(metrics.providerOutcomeCount).toBe(100);
    expect(metrics.deliveredRate).toBe(0.94);
    expect(metrics.bounceRate).toBe(0.03);
    expect(metrics.pendingFinalReceiptCount).toBe(3);
    expect(metrics.recommendation).toBe("bounce_threshold_reached");
  });

  it("gives complaints precedence over other recommendations", () => {
    const metrics = bulkEmailCampaignMetrics(report({ delivered: 95, bounced: 3, complained: 1, unknown: 1 }));

    expect(metrics.recommendation).toBe("pause_for_complaints");
    expect(metrics.needsReviewCount).toBe(2);
  });

  it("does not invent rates before a provider outcome exists", () => {
    const metrics = bulkEmailCampaignMetrics(report({ prepared: 100 }));

    expect(metrics.deliveredRate).toBeNull();
    expect(metrics.bounceRate).toBeNull();
    expect(metrics.recommendation).toBe("not_started");
  });
});
