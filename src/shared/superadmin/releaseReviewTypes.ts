export const RELEASE_REVIEW_STATUSES = [
  "pending",
  "approved",
  "declined",
] as const;

export type ReleaseReviewStatus = (typeof RELEASE_REVIEW_STATUSES)[number];
export type ReleaseReviewDecision = Exclude<ReleaseReviewStatus, "pending">;

export type PlatformReleaseReview = {
  id: string;
  deploymentId: string;
  changeSummary: string;
  status: ReleaseReviewStatus;
  emailSentAt: string | null;
  decidedAt: string | null;
};

export function isReleaseReviewStatus(
  value: unknown,
): value is ReleaseReviewStatus {
  return (
    typeof value === "string" &&
    (RELEASE_REVIEW_STATUSES as readonly string[]).includes(value)
  );
}
