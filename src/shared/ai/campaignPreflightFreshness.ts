export type CampaignPreflightFreshness = "fresh" | "expired" | "invalid";

export function campaignPreflightFreshness(
  validUntil: string,
  nowIso: string,
): CampaignPreflightFreshness {
  const validUntilMs = Date.parse(validUntil);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(validUntilMs) || !Number.isFinite(nowMs)) {
    return "invalid";
  }
  return validUntilMs > nowMs ? "fresh" : "expired";
}
