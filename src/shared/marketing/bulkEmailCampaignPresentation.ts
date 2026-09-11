export type BulkEmailCampaignPresentationStatus =
  | "draft"
  | "prepared"
  | "approved"
  | "sending"
  | "completed"
  | "cancelled";

export type BulkEmailCampaignDispatchStage =
  | "locked"
  | "canary"
  | "canary_complete"
  | "bulk"
  | "paused"
  | "completed";

export function shouldShowCampaignDispatchStage(
  status: BulkEmailCampaignPresentationStatus,
  dispatchStage: BulkEmailCampaignDispatchStage,
): boolean {
  if (status === "draft" || status === "prepared") return false;
  return !(status === "completed" && dispatchStage === "completed");
}
