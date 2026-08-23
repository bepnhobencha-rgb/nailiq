import "server-only";

/**
 * MQA-0181 is intentionally not a sender. Product policy for channel
 * precedence, EN/VI/FR fallback, contact hours, retries, compliance copy,
 * campaign caps, sender identity and the post-claim evidence freeze remains
 * deferred.
 */
export const REACTIVATION_CAMPAIGN_DELIVERY_HARD_OFF = true as const;

export type ReactivationCampaignDeliveryResult = {
  ok: false;
  error: "reactivation_campaign_delivery_disabled";
  providerCalled: false;
  databaseCalled: false;
};

/**
 * Literal first-instruction kill switch. Keep this function free of database
 * and provider imports until a separately reviewed product/release change is
 * authorized. There is deliberately no cron, route, action or UI callsite.
 */
export async function runReactivationCampaignDelivery(): Promise<ReactivationCampaignDeliveryResult> {
  if (REACTIVATION_CAMPAIGN_DELIVERY_HARD_OFF) {
    return {
      ok: false,
      error: "reactivation_campaign_delivery_disabled",
      providerCalled: false,
      databaseCalled: false,
    };
  }

  // The literal guard above is the complete runtime in this release.
  return {
    ok: false,
    error: "reactivation_campaign_delivery_disabled",
    providerCalled: false,
    databaseCalled: false,
  };
}
