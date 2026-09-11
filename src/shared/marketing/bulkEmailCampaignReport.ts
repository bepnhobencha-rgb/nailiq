export const BULK_EMAIL_RECIPIENT_STATUSES = [
  "prepared",
  "leased",
  "simulated",
  "providerAccepted",
  "delivered",
  "failed",
  "unknown",
  "suppressed",
  "bounced",
  "complained",
] as const;

export type BulkEmailRecipientCounts = Record<
  (typeof BULK_EMAIL_RECIPIENT_STATUSES)[number],
  number
>;

export type BulkEmailCampaignReport = {
  available: boolean;
  audienceCount: number;
  counts: BulkEmailRecipientCounts;
  globalSuppressionCount: number;
  deliveryReceiptCount: number;
  lastDeliveryEventAt: string | null;
  generatedAt: string | null;
};

export type BulkEmailCampaignMetrics = {
  providerOutcomeCount: number;
  deliveredRate: number | null;
  bounceRate: number | null;
  pendingFinalReceiptCount: number;
  needsReviewCount: number;
  terminalCount: number;
  recommendation:
    | "healthy"
    | "wait_for_receipts"
    | "review_failures"
    | "pause_for_complaints"
    | "bounce_threshold_reached"
    | "not_started";
};

export function emptyBulkEmailRecipientCounts(): BulkEmailRecipientCounts {
  return {
    prepared: 0,
    leased: 0,
    simulated: 0,
    providerAccepted: 0,
    delivered: 0,
    failed: 0,
    unknown: 0,
    suppressed: 0,
    bounced: 0,
    complained: 0,
  };
}

export function bulkEmailCampaignMetrics(
  report: BulkEmailCampaignReport,
): BulkEmailCampaignMetrics {
  const { counts } = report;
  const providerOutcomeCount =
    counts.providerAccepted
    + counts.delivered
    + counts.failed
    + counts.bounced
    + counts.complained;
  const pendingFinalReceiptCount =
    counts.prepared + counts.leased + counts.providerAccepted;
  const needsReviewCount = counts.failed + counts.unknown + counts.complained;
  const terminalCount =
    counts.simulated
    + counts.delivered
    + counts.failed
    + counts.unknown
    + counts.suppressed
    + counts.bounced
    + counts.complained;
  const deliveredRate = providerOutcomeCount > 0
    ? counts.delivered / providerOutcomeCount
    : null;
  const bounceRate = providerOutcomeCount > 0
    ? counts.bounced / providerOutcomeCount
    : null;

  let recommendation: BulkEmailCampaignMetrics["recommendation"] = "healthy";
  if (providerOutcomeCount === 0 && terminalCount === 0) {
    recommendation = "not_started";
  } else if (counts.complained > 0) {
    recommendation = "pause_for_complaints";
  } else if (bounceRate !== null && bounceRate >= 0.02) {
    recommendation = "bounce_threshold_reached";
  } else if (counts.failed > 0 || counts.unknown > 0) {
    recommendation = "review_failures";
  } else if (pendingFinalReceiptCount > 0) {
    recommendation = "wait_for_receipts";
  }

  return {
    providerOutcomeCount,
    deliveredRate,
    bounceRate,
    pendingFinalReceiptCount,
    needsReviewCount,
    terminalCount,
    recommendation,
  };
}
